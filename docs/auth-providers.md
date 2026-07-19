# HII social account providers

HII uses one Supabase Auth identity across passwordless email, Google, and Apple. The browser starts a PKCE OAuth flow and returns to `/auth/callback`, where HII exchanges the code for its existing cookie-backed session.

The login page reads the connected project's public Auth settings. A provider remains visibly pending and cannot be clicked until its Supabase configuration is enabled.

## Redirect configuration

Add these application URLs to Supabase Auth's redirect allow list:

- `https://humaninformationinterface.com/auth/callback`
- `https://www.humaninformationinterface.com/auth/callback`
- `http://127.0.0.1:5176/auth/callback` for the current local production preview

The provider console callback is the Supabase project callback shown on each provider's dashboard page, normally `https://<project-ref>.supabase.co/auth/v1/callback`. Google and Apple receive that Supabase URL, not HII's application callback.

## Google

1. Create a Web OAuth client in Google Auth Platform.
2. Add HII's production origin and the local origin while testing.
3. Add the Supabase project callback as an authorized redirect URI.
4. Enable Google in Supabase Auth and add the client ID and secret.
5. Keep scopes to `openid`, email, and profile unless HII intentionally adds a separate Gmail-data capability.

Google login authenticates a Google account. It does not grant HII access to Gmail messages.

## Apple

1. Create an Apple App ID with Sign in with Apple enabled.
2. Create a Services ID for the website and associate HII's domain.
3. Configure the Supabase project callback as the Services ID return URL.
4. Create and securely retain the Apple signing key, then generate the client secret.
5. Enable Apple in Supabase Auth. Put the web Services ID first if multiple client IDs are configured.

Apple's web OAuth client secret expires every six months. Record a private operational reminder to rotate it before expiry; never commit the `.p8` signing key or generated secret.
