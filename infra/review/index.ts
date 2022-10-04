import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// The following vars are not allowed to be undefined, hence the `${...}` magic

let route53Zone = `${process.env["ROUTE_53_ZONE"]}`;
let domain = `scorer.${process.env["DOMAIN"]}`;
let SCORER_SERVER_SSM_ARN = `${process.env["SCORER_SERVER_SSM_ARN"]}`;
let dbUsername = `${process.env["DB_USER"]}`;
let dbPassword = pulumi.secret(`${process.env["DB_PASSWORD"]}`);
let dbName = `${process.env["DB_NAME"]}`;

export const dockerGtcPassportIamImage = `${process.env["DOCKER_GTC_PASSPORT_SCORER_IMAGE"]}`;

//////////////////////////////////////////////////////////////
// Set up VPC
//////////////////////////////////////////////////////////////

const vpc = new awsx.ec2.Vpc("scorer", {
  subnets: [{ type: "public" }, { type: "private", mapPublicIpOnLaunch: true }],
});

export const vpcID = vpc.id;
export const vpcPrivateSubnetIds = vpc.privateSubnetIds;
export const vpcPublicSubnetIds = vpc.publicSubnetIds;

export const vpcPublicSubnet1 = vpcPublicSubnetIds.then((subnets) => {
  return subnets[0];
});

//////////////////////////////////////////////////////////////
// Set up RDS instance
//////////////////////////////////////////////////////////////
let dbSubnetGroup = new aws.rds.SubnetGroup(`scorer-db-subnet`, {
  subnetIds: vpcPrivateSubnetIds,
});

const db_secgrp = new aws.ec2.SecurityGroup(`scorer-db-secgrp`, {
  description: "Security Group for DB",
  vpcId: vpc.id,
  ingress: [
    {
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

// TODO: enable delete protection for the DB
const postgresql = new aws.rds.Instance(`scorer-db`, {
  allocatedStorage: 10,
  engine: "postgres",
  // engineVersion: "5.7",
  instanceClass: "db.t3.micro",
  name: dbName,
  password: dbPassword,
  username: dbUsername,
  skipFinalSnapshot: true,
  dbSubnetGroupName: dbSubnetGroup.id,
  vpcSecurityGroupIds: [db_secgrp.id],
});

export const rdsEndpoint = postgresql.endpoint;
export const rdsArn = postgresql.arn;
export const rdsConnectionUrl = pulumi.interpolate`psql://${dbUsername}:${dbPassword}@${rdsEndpoint}/${dbName}`;
export const rdsId = postgresql.id;

//////////////////////////////////////////////////////////////
// Set up ALB and ECS cluster
//////////////////////////////////////////////////////////////

const cluster = new awsx.ecs.Cluster("scorer", { vpc });
// export const clusterInstance = cluster;
export const clusterId = cluster.id;

// Generate an SSL certificate
const certificate = new aws.acm.Certificate("cert", {
  domainName: domain,
  tags: {
    Environment: "review",
  },
  validationMethod: "DNS",
});

const certificateValidationDomain = new aws.route53.Record(
  `${domain}-validation`,
  {
    name: certificate.domainValidationOptions[0].resourceRecordName,
    zoneId: route53Zone,
    type: certificate.domainValidationOptions[0].resourceRecordType,
    records: [certificate.domainValidationOptions[0].resourceRecordValue],
    ttl: 600,
  }
);

const certificateValidation = new aws.acm.CertificateValidation(
  "certificateValidation",
  {
    certificateArn: certificate.arn,
    validationRecordFqdns: [certificateValidationDomain.fqdn],
  },
  { customTimeouts: { create: "30s", update: "30s" } }
);

// Creates an ALB associated with our custom VPC.
const alb = new awsx.lb.ApplicationLoadBalancer(`scorer-service`, { vpc });

// Listen to HTTP traffic on port 80 and redirect to 443
const httpListener = alb.createListener("web-listener", {
  port: 80,
  protocol: "HTTP",
  defaultAction: {
    type: "redirect",
    redirect: {
      protocol: "HTTPS",
      port: "443",
      statusCode: "HTTP_301",
    },
  },
});

// Target group with the port of the Docker image
const target = alb.createTargetGroup("scorer-target", {
  vpc,
  port: 80,
  healthCheck: { path: "/health", unhealthyThreshold: 5 },
});

// Listen to traffic on port 443 & route it through the target group
const httpsListener = target.createListener("scorer-listener", {
  port: 443,
  certificateArn: certificateValidation.certificateArn,
});

// Create a DNS record for the load balancer
const www = new aws.route53.Record("scorer", {
  zoneId: route53Zone,
  name: domain,
  type: "A",
  aliases: [
    {
      name: httpsListener.endpoint.hostname,
      zoneId: httpsListener.loadBalancer.loadBalancer.zoneId,
      evaluateTargetHealth: true,
    },
  ],
});

// TODO connect EFS with Fargate containers
// const ceramicStateStore = new aws.efs.FileSystem("ceramic-statestore");

const dpoppEcsRole = new aws.iam.Role("dpoppEcsRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Sid: "",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
      },
    ],
  }),
  inlinePolicies: [
    {
      name: "allow_iam_secrets_access",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["secretsmanager:GetSecretValue"],
            Effect: "Allow",
            Resource: SCORER_SERVER_SSM_ARN,
          },
        ],
      }),
    },
  ],
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  ],
  tags: {
    dpopp: "",
  },
});

const service = new awsx.ecs.FargateService("scorer", {
  cluster,
  desiredCount: 1,
  subnets: vpc.privateSubnetIds,
  taskDefinitionArgs: {
    executionRole: dpoppEcsRole,
    containers: {
      scorer: {
        image: dockerGtcPassportIamImage,
        memory: 1024,
        portMappings: [httpsListener],
        links: [],
        secrets: [
          {
            name: "SECRET_KEY",
            valueFrom: `${SCORER_SERVER_SSM_ARN}:SECRET_KEY::`,
          },
        ],
        environment: [
          {
            name: "DEBUG",
            value: "on",
          },
          {
            name: "DATABASE_URL",
            value: rdsConnectionUrl,
          },
          {
            name: "ALLOWED_HOSTS",
            value: JSON.stringify(domain),
          },
        ],
      },
    },
  },
});

// const ecsTarget = new aws.appautoscaling.Target("autoscaling_target", {
//   maxCapacity: 1,
//   minCapacity: 1,
//   resourceId: pulumi.interpolate`service/${cluster.cluster.name}/${service.service.name}`,
//   scalableDimension: "ecs:service:DesiredCount",
//   serviceNamespace: "ecs",
// });
