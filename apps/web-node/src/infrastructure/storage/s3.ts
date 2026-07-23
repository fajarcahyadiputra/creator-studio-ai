import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";

function buildClient(endpoint: string): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    endpoint,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
  });
}

export const s3Internal = buildClient(String(env.S3_ENDPOINT));
export const s3PublicSigner = buildClient(String(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT));

function rewriteSignedUrlOrigin(signedUrl: string, publicOrigin?: string) {
  if (!publicOrigin) return signedUrl;

  try {
    const sourceUrl = new URL(signedUrl);
    const targetOrigin = new URL(publicOrigin);
    sourceUrl.protocol = targetOrigin.protocol;
    sourceUrl.hostname = targetOrigin.hostname;
    sourceUrl.port = targetOrigin.port;
    return sourceUrl.toString();
  } catch {
    return signedUrl;
  }
}

export async function createInternalSignedObjectReadUrl(objectKey: string, expiresIn = env.SIGNED_URL_TTL_SECONDS) {
  return getSignedUrl(
    s3Internal,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET_MEDIA,
      Key: objectKey,
    }),
    { expiresIn }
  );
}

export async function createPublicSignedObjectReadUrl(
  objectKey: string,
  expiresIn = env.SIGNED_URL_TTL_SECONDS,
  publicOrigin?: string
) {
  const signedUrl = await getSignedUrl(
    s3PublicSigner,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET_MEDIA,
      Key: objectKey,
    }),
    { expiresIn }
  );
  if (env.S3_PUBLIC_ENDPOINT) {
    return signedUrl;
  }
  return rewriteSignedUrlOrigin(signedUrl, publicOrigin);
}

export async function createInternalSignedObjectWriteUrl(
  objectKey: string,
  contentType: string,
  expiresIn = env.SIGNED_URL_TTL_SECONDS,
) {
  return getSignedUrl(
    s3Internal,
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_MEDIA,
      Key: objectKey,
      ContentType: contentType,
    }),
    { expiresIn }
  );
}

export async function createPublicSignedObjectWriteUrl(
  objectKey: string,
  contentType: string,
  expiresIn = env.SIGNED_URL_TTL_SECONDS,
  publicOrigin?: string
) {
  const signedUrl = await getSignedUrl(
    s3PublicSigner,
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_MEDIA,
      Key: objectKey,
      ContentType: contentType,
    }),
    { expiresIn }
  );
  if (env.S3_PUBLIC_ENDPOINT) {
    return signedUrl;
  }
  return rewriteSignedUrlOrigin(signedUrl, publicOrigin ?? String(env.S3_ENDPOINT));
}

export async function putObjectBuffer(objectKey: string, body: Uint8Array, contentType: string) {
  await s3Internal.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_MEDIA,
      Key: objectKey,
      Body: body,
      ContentType: contentType
    })
  );
}

export async function objectExists(objectKey: string): Promise<boolean> {
  try {
    await s3Internal.send(
      new HeadObjectCommand({
        Bucket: env.S3_BUCKET_MEDIA,
        Key: objectKey,
      })
    );
    return true;
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "$metadata" in error
        ? (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode
        : undefined;
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (statusCode === 404 || name === "NotFound" || name === "NoSuchKey") {
      return false;
    }
    throw error;
  }
}

export async function deleteObjectKeys(objectKeys: string[]) {
  const keys = [...new Set(objectKeys.filter((value) => typeof value === "string" && value.trim().length > 0))];
  if (keys.length === 0) return;

  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000);
    await s3Internal.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET_MEDIA,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: true,
        },
      })
    );
  }
}
