import { UserManager, WebStorageStateStore, type User, type UserManagerSettings } from 'oidc-client-ts';
import type { WebConfig } from '../config.js';
export function authSettings(config: WebConfig, storage: Storage): UserManagerSettings {
  return {
    authority: config.cognitoAuthority,
    client_id: config.cognitoClientId,
    redirect_uri: config.callbackUrl,
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid email profile',
    disablePKCE: false,
    loadUserInfo: false,
    automaticSilentRenew: false,
    monitorSession: false,
    requestTimeoutInSeconds: 10,
    staleStateAgeInSeconds: 600,
    stateStore: new WebStorageStateStore({ store: storage }),
    userStore: new WebStorageStateStore({ store: storage }),
    metadata: {
      issuer: config.cognitoAuthority,
      authorization_endpoint: config.cognitoLoginUrl + '/oauth2/authorize',
      token_endpoint: config.cognitoLoginUrl + '/oauth2/token',
      revocation_endpoint: config.cognitoLoginUrl + '/oauth2/revoke',
      jwks_uri: config.cognitoAuthority + '/.well-known/jwks.json',
    },
  };
}
export function userIdentity(user: User | null, config: WebConfig, now = Date.now()): { sub: string } | null {
  if (!user?.id_token || user.id_token.length > 32768) return null;
  try {
    const pieces = user.id_token.split('.');
    if (pieces.length !== 3 || !pieces.every((v) => /^[A-Za-z0-9_-]+$/.test(v))) return null;
    const value = JSON.parse(atob(pieces[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    if (
      value.token_use !== 'id' ||
      value.iss !== config.cognitoAuthority ||
      value.aud !== config.cognitoClientId ||
      typeof value.sub !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.sub) ||
      value.sub !== user.profile.sub ||
      !Number.isSafeInteger(value.exp) ||
      value.exp * 1000 <= now
    )
      return null;
    return { sub: value.sub };
  } catch {
    return null;
  }
}
export function returnPath(value: unknown): string {
  return typeof value === 'string' &&
    (/^\/sessions\/[a-f0-9-]{36}(?:\/(?:debrief|playback))?$/.test(value) || value === '/')
    ? value
    : '/';
}
export class AuthSession {
  readonly manager: UserManager;
  private refreshing: Promise<User | null> | undefined;
  constructor(
    readonly config: WebConfig,
    storage: Storage,
  ) {
    this.manager = new UserManager(authSettings(config, storage));
  }
  async token(): Promise<string | null> {
    let user = await this.manager.getUser();
    if (!user) return null;
    if (!userIdentity(user, this.config)) {
      if (!user.refresh_token) {
        await this.manager.removeUser();
        return null;
      }
      this.refreshing ??= this.manager.signinSilent().finally(() => {
        this.refreshing = undefined;
      });
      try {
        user = await this.refreshing;
      } catch {
        await this.manager.removeUser();
        return null;
      }
    }
    if (!userIdentity(user, this.config)) {
      await this.manager.removeUser();
      return null;
    }
    return user!.id_token!;
  }
  signIn(path: string) {
    return this.manager.signinRedirect({ nonce: crypto.randomUUID(), state: { path: returnPath(path) } });
  }
  async signOut() {
    try {
      await this.manager.revokeTokens(['refresh_token']);
    } catch {
      /* Local sign-out must still complete if revocation is unavailable. */
    }
    await this.manager.removeUser();
    const url = new URL('/logout', this.config.cognitoLoginUrl);
    url.searchParams.set('client_id', this.config.cognitoClientId);
    url.searchParams.set('logout_uri', this.config.logoutUrl);
    return url.href;
  }
}
