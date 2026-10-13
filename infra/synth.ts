import { App } from 'aws-cdk-lib';
import { CheckpointFoundationStack } from './checkpoint-foundation-stack.js';
import { ContentPublicationStack } from './content-publication-stack.js';
import { GitHubOidcProviderStack } from './github-oidc-provider-stack.js';
import { ReferenceEnvironmentStack } from './reference-environment-stack.js';
import { SessionStartStack } from './session-start-stack.js';
import { TerminalEdgeProtectionStack } from './terminal-edge-protection-stack.js';

// CDK library synthesis only: no CLI credential lookup, bootstrap, or AWS API calls.
const app = new App({ outdir: process.env.CDK_OUTDIR ?? 'cdk.out' });
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const deployment = account && region ? { env: { account, region } } : undefined;
new GitHubOidcProviderStack(app, 'OpsReplayGitHubOidcProvider', deployment);
new CheckpointFoundationStack(app, 'OpsReplayCheckpointFoundation', deployment);
new ContentPublicationStack(app, 'OpsReplayContentPublication', deployment);
new SessionStartStack(app, 'OpsReplaySessionStart', deployment);
// Explicit output-to-parameter handoff avoids cross-Region CloudFormation exports.
new TerminalEdgeProtectionStack(app, 'OpsReplayTerminalEdgeProtection', {
  env: { ...(account ? { account } : {}), region: 'us-east-1' },
});
new ReferenceEnvironmentStack(app, 'OpsReplayReferenceEnvironment', deployment);
app.synth();
