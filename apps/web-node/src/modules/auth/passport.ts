import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { env } from "../../config/env.js";
import { AuthService } from "./auth-service.js";
import { logger } from "../../shared/logging/logger.js";

export function configurePassport(authService: AuthService): void {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_CALLBACK_URL) {
    logger.info("Google OAuth is disabled because credentials are not configured");
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: env.GOOGLE_CALLBACK_URL
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.find((item) => item.verified)?.value ?? profile.emails?.[0]?.value;
          if (!email) return done(new Error("Google did not return an email address."));
          const user = await authService.findOrCreateGoogleUser({
            providerAccountId: profile.id,
            email: email.toLowerCase(),
            displayName: profile.displayName || email.split("@")[0] || "Creator"
          });
          done(null, user);
        } catch (error) {
          done(error as Error);
        }
      }
    )
  );
}
