import * as blueprints from '@aws-quickstart/eks-blueprints';
import { getSecretValue } from '@aws-quickstart/eks-blueprints/dist/utils/secrets-manager-utils';
import { KubecostAddOn } from '@kubecost/kubecost-eks-blueprints-addon';
import * as cdk from 'aws-cdk-lib';
import { StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import { Construct } from 'constructs';
// Team implementations
import * as team from '../teams/pipeline-multi-env-gitops';



export interface PipelineMultiEnvGitopsProps {
    /**
     * The CDK environment where dev&test, prod, and piplines will be deployed to 
     */
    devEnv: cdk.Environment;
    prodEnv: cdk.Environment;
    pipelineEnv: cdk.Environment;
}

export default class PipelineMultiEnvGitops {
    readonly DEFAULT_ENV: cdk.Environment =
        {
            account: process.env.CDK_DEFAULT_ACCOUNT,
            region: process.env.CDK_DEFAULT_REGION,
        };

    async buildAsync(scope: Construct, id: string, pipelineProps: PipelineMultiEnvGitopsProps, props?: StackProps) {

        // environments IDs consts
        const DEV_ENV_ID = `dev-${pipelineProps.devEnv.region}`
        const TEST_ENV_ID = `test-${pipelineProps.devEnv.region}`
        const PROD_ENV_ID = `prod-${pipelineProps.prodEnv.region}`
        const PROD_ENV_ID_2 = `prod-${pipelineProps.prodEnv.region}`

        // build teams per environments
        const devTeams = createTeamList('dev', scope, pipelineProps.devEnv.account!);
        const testTeams = createTeamList('test', scope, pipelineProps.devEnv.account!);
        const prodTeams = createTeamList('prod', scope, pipelineProps.prodEnv.account!);

        try {
            // github-token is needed for CDK Pipeline functionality
            await getSecretValue('github-token', pipelineProps.pipelineEnv.region!); // Exclamation mark is used to avoid msg: ts(2345)
        }
        catch (error) {
            throw new Error(`github-token secret must be setup in AWS Secrets Manager for the GitHub pipeline.
                    The GitHub Personal Access Token should have these scopes:
                    * **repo** - to read the repository
                    * * **admin:repo_hook** - if you plan to use webhooks (true by default)
                    * @see https://docs.aws.amazon.com/codepipeline/latest/userguide/GitHub-create-personal-token-CLI.html`);
        }

        const clusterVersion = eks.KubernetesVersion.V1_21;

        /* eslint-disable */
        const blueMNG = new blueprints.MngClusterProvider({
            id: "primary-mng-blue",
            version: clusterVersion,
            minSize: 1,
            maxSize: 100,
            nodeGroupCapacityType: eks.CapacityType.SPOT,
            instanceTypes: [
                new ec2.InstanceType("m5.2xlarge"),
                new ec2.InstanceType("m5a.2xlarge"),
                new ec2.InstanceType("m5ad.2xlarge"),
                new ec2.InstanceType("m5d.2xlarge"),
            ],
        });
        const greenMNG = new blueprints.MngClusterProvider({
            id: "primary-mng-green",
            version: clusterVersion,
            minSize: 1,
            maxSize: 100,
            nodeGroupCapacityType: eks.CapacityType.SPOT,
            instanceTypes: [
                new ec2.InstanceType("m5.xlarge"),
                new ec2.InstanceType("m5a.xlarge"),
                new ec2.InstanceType("m5ad.xlarge"),
                new ec2.InstanceType("m5d.xlarge"),
            ],
        });

        const blueprint = blueprints.EksBlueprint.builder()
            .version(clusterVersion)
            .clusterProvider(
                // blueMNG,
                greenMNG,
            )
            .addOns(
                // default addons for all environments
                new blueprints.SecretsStoreAddOn,
                new blueprints.AwsLoadBalancerControllerAddOn,
                new blueprints.NginxAddOn,
                new blueprints.AppMeshAddOn({
                    enableTracing: true
                }),
                new blueprints.CalicoAddOn,
                new blueprints.MetricsServerAddOn,
                new blueprints.ClusterAutoScalerAddOn(),
                new blueprints.ContainerInsightsAddOn,
                new blueprints.XrayAddOn,
                new KubecostAddOn,
            );

        // Argo configuration per environment
        // const devArgoAddonConfig = createArgoAddonConfig('dev', 'git@github.com:aws-samples/eks-blueprints-workloads.git');
        // const testArgoAddonConfig = createArgoAddonConfig('test', 'git@github.com:aws-samples/eks-blueprints-workloads.git');
        // const prodArgoAddonConfig = createArgoAddonConfig('prod', 'git@github.com:aws-samples/eks-blueprints-workloads.git');
        const devArgoAddonConfig = createArgoAddonConfig('dev', 'git@github.com:tsahiduek/eks-blueprints-workloads.git');
        const testArgoAddonConfig = createArgoAddonConfig('test', 'git@github.com:tsahiduek/eks-blueprints-workloads.git');
        const prodArgoAddonConfig = createArgoAddonConfig('prod', 'git@github.com:tsahiduek/eks-blueprints-workloads.git');

        try {

            // const { gitOwner, gitRepositoryName } = await getRepositoryData();
            const gitOwner = 'tsahiduek';
            const gitRepositoryName = 'cdk-eks-blueprints-patterns';

            blueprints.CodePipelineStack.builder()
                .name("eks-blueprint-pipeline")
                .owner(gitOwner)
                .repository({
                    repoUrl: gitRepositoryName,
                    credentialsSecretName: 'github-token',
                    targetRevision: 'main',
                })
                .wave({
                    id: "dev-test",
                    stages: [
                        {
                            id: DEV_ENV_ID,
                            stackBuilder: blueprint
                                .clone(pipelineProps.devEnv.region, pipelineProps.devEnv.account)
                                .name(DEV_ENV_ID)
                                .teams(...devTeams)
                                .addOns(
                                    devArgoAddonConfig,
                                )
                        },
                        {
                            id: TEST_ENV_ID,
                            stackBuilder: blueprint
                                .clone(pipelineProps.devEnv.region, pipelineProps.devEnv.account)
                                .name(TEST_ENV_ID)
                                .teams(...testTeams)
                                .addOns(
                                    testArgoAddonConfig,
                                )
                        },

                    ],
                    props: {
                        post: [new blueprints.pipelines.cdkpipelines.ManualApprovalStep('manual-approval-before-production')]
                    }
                })
                .wave({
                    id: "prod",
                    stages: [
                        {
                            id: PROD_ENV_ID,
                            stackBuilder: blueprint
                                .clone(pipelineProps.prodEnv.region, pipelineProps.prodEnv.account)
                                .name(PROD_ENV_ID)
                                .teams(...prodTeams)
                                .addOns(
                                    prodArgoAddonConfig,
                                )
                        },
                        {
                            id: PROD_ENV_ID_2,
                            stackBuilder: blueprint
                                .clone(pipelineProps.prodEnv.region, pipelineProps.prodEnv.account)
                                .name(PROD_ENV_ID)
                                .teams(...prodTeams)
                                .addOns(
                                    prodArgoAddonConfig,
                                )
                        },
                    ]
                })
                .build(scope, "eks-blueprint-pipeline-stack", props);
        } catch (error) {
            console.log(error)
        }
    }
}



function createTeamList(environments: string, scope: Construct, account: string): Array<blueprints.Team> {
    const teamsList = [
        new team.CorePlatformTeam(account, environments),
        new team.FrontendTeam(account, environments),
        new team.BackendNodejsTeam(account, environments),
        new team.BackendCrystalTeam(account, environments),
    ];
    return teamsList;

}
function createArgoAddonConfig(environment: string, repoUrl: string): blueprints.ArgoCDAddOn {
    interface argoProjectParams {
        githubOrg: string,
        githubRepository: string,
        projectNamespace: string
    }
    let argoAdditionalProject: Array<Record<string, unknown>> = [];
    const projectNameList: argoProjectParams[] =
        [
            { githubOrg: 'aws-containers', githubRepository: 'ecsdemo-frontend', projectNamespace: 'ecsdemo-frontend' },
            { githubOrg: 'aws-containers', githubRepository: 'ecsdemo-nodejs', projectNamespace: 'ecsdemo-nodejs' },
            { githubOrg: 'aws-containers', githubRepository: 'ecsdemo-crystal', projectNamespace: 'ecsdemo-crystal' },
        ];

    projectNameList.forEach(element => {
        argoAdditionalProject.push(
            {
                name: element.githubRepository,
                namespace: "argocd",
                destinations: [{
                    namespace: element.projectNamespace,
                    server: "https://kubernetes.default.svc"
                }],
                sourceRepos: [
                    `git@github.com:${element.githubOrg}/${element.githubRepository}.git`,
                    `git@github.com:aws-samples/eks-blueprints-workloads.git`,
                    `git@github.com:tsahiduek/eks-blueprints-workloads.git`,
                ],
            }
        );
    });

    const argoConfig = new blueprints.ArgoCDAddOn(
        {
            bootstrapRepo: {
                repoUrl: repoUrl,
                path: `multi-repo/argo-app-of-apps/${environment}`,
                targetRevision: 'main',
                credentialsSecretName: 'github-ssh-key',
                credentialsType: 'SSH'
            },
            bootstrapValues: {
                service: {
                    type: 'LoadBalancer'
                },
                spec: {
                    ingress: {
                        host: 'dev.blueprint.com',
                    },
                },
            },
            values: {
                server: {
                    additionalProjects: argoAdditionalProject,
                }
            }
        }
    )

    return argoConfig
}