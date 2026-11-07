// What signing in needs from an identity provider. Only identity is asked
// for: a sign-in never connects a forge or reads repositories.

export interface SignInProfile {
  providerUserId: string;
  // Verified by the provider; profile() fails rather than return an
  // unverified address, since accounts are created and matched by email.
  email: string;
  name: string;
}

export interface AuthorizeParams {
  state: string;
  challenge: string;
  redirectUri: string;
}

export interface ExchangeParams {
  code: string;
  verifier: string;
  redirectUri: string;
}

export interface SignInProviderDefinition {
  label: string;
  host(): string;
  // Whether this server has the provider's OAuth app; unconfigured providers
  // are hidden from the login page and their routes answer 404.
  configured(): boolean;
  authorizeUrl(params: AuthorizeParams): string;
  // Returns the access token, used only to read the profile and then dropped.
  exchangeCode(params: ExchangeParams): Promise<string>;
  profile(accessToken: string): Promise<SignInProfile>;
}

// The provider reported no verified email, so the account cannot be matched
// or created safely.
export class UnverifiedEmailError extends Error {}
