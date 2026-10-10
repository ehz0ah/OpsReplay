export interface TerminalTicketConfiguration {
  gatewayUrl: string;
}

export const terminalTicketLifetimeSeconds = 60;

export function validTerminalGatewayUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'wss:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === '/v1/terminal'
    );
  } catch {
    return false;
  }
}

export function loadTerminalTicketConfiguration(environment: NodeJS.ProcessEnv): TerminalTicketConfiguration {
  const gatewayUrl = environment.TERMINAL_GATEWAY_URL;
  if (!validTerminalGatewayUrl(gatewayUrl)) throw new Error('TERMINAL_GATEWAY_URL is invalid');
  return { gatewayUrl };
}
