import { App } from 'aws-cdk-lib';
import { CheckpointFoundationStack } from './checkpoint-foundation-stack.js';
import { GitHubOidcProviderStack } from './github-oidc-provider-stack.js';
import { SessionStartStack } from './session-start-stack.js';

// CDK library synthesis only: no CLI credential lookup, bootstrap, or AWS API calls.
const app = new App({ outdir: process.env.CDK_OUTDIR ?? 'cdk.out' });
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const deployment = account && region ? { env: { account, region } } : undefined;
new GitHubOidcProviderStack(app, 'OpsReplayGitHubOidcProvider', deployment);
new CheckpointFoundationStack(app, 'OpsReplayCheckpointFoundation', deployment);
new SessionStartStack(app, 'OpsReplaySessionStart', deployment);
app.synth();
