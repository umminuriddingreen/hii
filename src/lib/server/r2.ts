import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '$env/dynamic/private';

let _client: S3Client | null = null;

function client(): S3Client {
  if (_client) return _client;
  const accountId = env.R2_ACCOUNT_ID;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? ''
    }
  });
  return _client;
}

export function r2Configured(): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

/** Signed URL the producer's browser PUTs the raw file to. */
export async function presignUpload(key: string, contentType: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: contentType
  });
  return getSignedUrl(client(), cmd, { expiresIn: 60 * 10 }); // 10 min
}

/** Short-lived signed URL minted ONLY after a paid purchase. */
export async function presignDownload(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
  return getSignedUrl(client(), cmd, { expiresIn: 60 * 5 }); // 5 min
}
