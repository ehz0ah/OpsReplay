const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumGeneration = 999_999_999;

export function isMonitorRecordingSessionId(value: string): boolean {
  return sessionIdPattern.test(value);
}

export function isMonitorRecordingGeneration(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximumGeneration;
}

export function isMonitorRecordingIdentity(sessionId: string, generation: number): boolean {
  return isMonitorRecordingSessionId(sessionId) && isMonitorRecordingGeneration(generation);
}
