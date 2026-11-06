"use client";

import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId:
        process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID!,
      userPoolClientId:
        process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID!,
    },
  },
});

export default function AuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Authenticator>
      {({ user, signOut }) => (
        <div>
          <header>
            <p>Signed in as {user?.username}</p>
            <button onClick={signOut}>Sign out</button>
          </header>

          {children}
        </div>
      )}
    </Authenticator>
  );
}