import type { CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { captureLimits } from '../packages/contracts/private/file-capture.js';

/** Publication input, not a deployed environment task. The current stack accepts
 * externally published task revisions. Apply this layout to both containers in
 * the same Fargate task before publishing a Challenge that declares watched files. */
export function environmentWatchedVolume(): {
  volume: CfnTaskDefinition.VolumeProperty;
  challenge: { mountPoint: CfnTaskDefinition.MountPointProperty; environment: CfnTaskDefinition.KeyValuePairProperty };
  monitor: { mountPoint: CfnTaskDefinition.MountPointProperty };
} {
  const name = 'watched-files';
  return {
    volume: { name },
    challenge: {
      mountPoint: { sourceVolume: name, containerPath: captureLimits.root, readOnly: false },
      environment: { name: 'OPSREPLAY_WATCHED_FILES', value: '1' },
    },
    monitor: { mountPoint: { sourceVolume: name, containerPath: captureLimits.root, readOnly: true } },
  };
}
