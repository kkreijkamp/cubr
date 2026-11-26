// Prints a VAPID key pair for the daily reminders, in web-push's format: the public key as an
// uncompressed P-256 point and the private key as its 32 bytes, both base64url. deploy.sh runs it on
// the VM the first time (with the solve image's Node) and adds the two lines to /opt/cubr/.env, so the
// private key never leaves the VM. New keys end every subscription: people turn reminders on again.
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
console.log(`VAPID_PUBLIC_KEY=${point.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey.export({ format: 'jwk' }).d}`);
