import assert from 'node:assert/strict'
import test from 'node:test'
import tencentcloud from 'tencentcloud-sdk-nodejs-sms'

test('dedicated Tencent SMS SDK exposes the existing SendSms client contract', () => {
  const SmsClient = tencentcloud.sms.v20210111.Client
  const client = new SmsClient({
    credential: { secretId: 'test-id', secretKey: 'test-key' },
    region: 'ap-guangzhou',
    profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: {
        reqMethod: 'POST',
        reqTimeout: 30,
        endpoint: 'sms.tencentcloudapi.com',
      },
    },
  })

  assert.equal(typeof client.SendSms, 'function')
})
