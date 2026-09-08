// 自己署名証明書を作成（スマホのブラウザでマイク＝Web Speech API を使うには HTTPS が必要）
// 実行: npm run make-cert  → certs/server.key, certs/server.crt を生成。サーバー再起動で HTTPS(:3443) が有効になる。
import selfsigned from 'selfsigned'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(__dirname, '..', 'certs')
fs.mkdirSync(dir, { recursive: true })

const ips = []
for (const list of Object.values(os.networkInterfaces())) {
  for (const i of list) if (i.family === 'IPv4' && !i.internal) ips.push(i.address)
}
const altNames = [
  { type: 2, value: 'localhost' },
  { type: 2, value: os.hostname().toLowerCase() },
  { type: 7, ip: '127.0.0.1' },
  ...ips.map((ip) => ({ type: 7, ip })),
]
const pems = selfsigned.generate([{ name: 'commonName', value: 'VoiceMemo Local' }], {
  days: 3650,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ],
})
fs.writeFileSync(path.join(dir, 'server.key'), pems.private)
fs.writeFileSync(path.join(dir, 'server.crt'), pems.cert)
console.log('証明書を作成しました:', dir)
console.log('SAN:', ['localhost', os.hostname().toLowerCase(), '127.0.0.1', ...ips].join(', '))
console.log('スマホに server.crt をインストール（信頼）すると https://<PCのIP>:3443 でマイクが使えます。')
