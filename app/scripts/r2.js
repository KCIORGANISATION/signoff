import { S3Client } from '@aws-sdk/client-s3';

export const PREFIX = 'signoff/';

// Cloudflare R2 speaks the S3 protocol; credentials come from the environment.
export function r2() {
  const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'].filter((name) => !process.env[name]);
  if (missing.length > 0) fail(`Missing environment variables: ${missing.join(', ')}`);

  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return { client, bucket: process.env.R2_BUCKET };
}

export function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
