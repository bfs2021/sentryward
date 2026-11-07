-- Where a provider login lands afterwards (#230 review). Stored encrypted,
-- like the invite token beside it.
ALTER TABLE "sign_in_states" ADD COLUMN "return_to" TEXT;
