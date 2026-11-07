-- Sign in with GitHub or GitLab (#230). Accounts created through a provider
-- have no password until the user sets one.
CREATE TYPE "sign_in_provider" AS ENUM ('github', 'gitlab');

CREATE TYPE "sign_in_intent" AS ENUM ('login', 'link');

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "sign_in_provider" NOT NULL,
    "host" TEXT NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sign_in_states" (
    "id" TEXT NOT NULL,
    "provider" "sign_in_provider" NOT NULL,
    "intent" "sign_in_intent" NOT NULL,
    "user_id" UUID,
    "invite_token" TEXT,
    "code_verifier" TEXT NOT NULL,
    "browser_nonce_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_in_states_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_identities_user_id_idx" ON "user_identities"("user_id");

CREATE UNIQUE INDEX "user_identities_provider_host_provider_user_id_key" ON "user_identities"("provider", "host", "provider_user_id");

ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sign_in_states" ADD CONSTRAINT "sign_in_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
