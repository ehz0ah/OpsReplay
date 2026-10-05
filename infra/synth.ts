import { App } from 'aws-cdk-lib';
import { SessionStartStack } from './session-start-stack.js';

// CDK library synthesis only: no CLI credential lookup, bootstrap, or AWS API calls.
const app = new App({ outdir: 'cdk.out' });
new SessionStartStack(app, 'OpsReplaySessionStart');
app.synth();
