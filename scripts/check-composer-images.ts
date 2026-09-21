import assert from 'node:assert/strict';
import { imageAdmissionError, IMAGE_LIMITS } from '../src/shared/attachments';
import { DEFAULT_ATTACHMENT_LIMITS } from '../server/attachment/normalize';

const png = { type: 'image/png', size: 1024 };
assert.equal(imageAdmissionError(Array(6).fill(png)), null, 'the six reference attachments must all survive admission');
assert.equal(imageAdmissionError([{ ...png, size: 6 * 1024 * 1024 }]), null, 'ordinary images above the previous 5MB cap work');
assert.equal(imageAdmissionError(Array(20).fill(png)), null);
assert.match(imageAdmissionError([png], Array(20).fill(png))!, /20 张/);
assert.match(imageAdmissionError([{ ...png, size: IMAGE_LIMITS.maxImageBytes + 1 }])!, /20MB/);
assert.match(imageAdmissionError([{ ...png, size: 13 * 1024 * 1024 }], [{ size: 12 * 1024 * 1024 }])!, /24MB/);
assert.match(imageAdmissionError([{ ...png, size: 0 }])!, /为空/);
assert.match(imageAdmissionError([{ type: 'application/pdf', size: 10 }])!, /PNG/);
for (const [key, limit] of Object.entries(IMAGE_LIMITS)) {
  assert.equal(DEFAULT_ATTACHMENT_LIMITS[key as keyof typeof IMAGE_LIMITS], limit, 'browser and host must enforce the same admission policy');
}
console.log('PASS composer image admission: six images, >5MB, count/size/type failures and host parity');
