import "server-only";

import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  JwtInvalidClaimError, JwtInvalidSignatureAlgorithmError, JwtInvalidSignatureError,
  JwtParseError, JwtWithoutValidKidError, KidNotFoundInJwksError, ParameterValidationError,
  WaitPeriodNotYetEndedJwkError,
} from "aws-jwt-verify/error";
import { ProfileError } from "../domain/profile";

function createVerifier() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID ?? process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) throw new Error("Cognito server configuration is missing");
  return CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
}

let verifier: ReturnType<typeof createVerifier> | undefined;

export async function authenticatedSubject(request: Request): Promise<string> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new ProfileError("UNAUTHORIZED", "Sign in to continue.", 401);
  verifier ??= createVerifier();
  try {
    const payload = await verifier.verify(match[1]);
    if (!payload.sub) throw new ProfileError("UNAUTHORIZED", "Invalid authentication token.", 401);
    return payload.sub;
  } catch (error) {
    if (
      error instanceof JwtInvalidClaimError || error instanceof JwtInvalidSignatureError ||
      error instanceof JwtInvalidSignatureAlgorithmError || error instanceof JwtParseError ||
      error instanceof JwtWithoutValidKidError || error instanceof KidNotFoundInJwksError ||
      error instanceof ParameterValidationError ||
      error instanceof WaitPeriodNotYetEndedJwkError
    ) {
      throw new ProfileError("UNAUTHORIZED", "Your session is invalid or expired. Sign in again.", 401);
    }
    // JWKS/network outages remain service failures, never trusted identities.
    throw error;
  }
}
