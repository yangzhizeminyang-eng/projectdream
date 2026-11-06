import {
  createObjectStorageFromEnv,
  inspectObjectStorageReadiness,
  normalizeObjectKey,
} from '../server/services/object-storage.mjs'

const DEFAULT_OBJECT_KEY = '__projectdream_preflight__/read-only-check'

function readOption(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))
  return value ? value.slice(prefix.length) : null
}

function redactErrorMessage(error, env) {
  let message = error instanceof Error ? error.message : 'object storage preflight failed'
  for (const value of [env.COS_SECRET_ID, env.COS_SECRET_KEY]) {
    const secret = String(value || '').trim()
    if (secret) message = message.replaceAll(secret, '[REDACTED]')
  }
  return message
}

async function main() {
  const readiness = inspectObjectStorageReadiness(process.env)
  if (!readiness.ready) {
    throw new Error(
      readiness.provider === 'cos'
        ? `COS configuration is incomplete: ${readiness.missing.join(', ')}`
        : `unsupported object storage provider: ${readiness.provider}`,
    )
  }

  const key = normalizeObjectKey(readOption('object-key') || DEFAULT_OBJECT_KEY)
  const storage = createObjectStorageFromEnv(process.env)
  const signedUrl = storage.createSignedUrl({ key })
  const parsedUrl = new URL(signedUrl)
  const object = await storage.headObject(key)

  console.log(JSON.stringify({
    mode: 'read-only',
    provider: storage.provider,
    objectKey: key,
    objectStatus: object ? 'exists' : 'missing',
    signedUrlProtocol: parsedUrl.protocol,
    signedUrlHost: parsedUrl.host,
  }, null, 2))
}

main().catch((error) => {
  console.error(redactErrorMessage(error, process.env))
  process.exitCode = 1
})
