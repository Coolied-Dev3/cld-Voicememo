// デルタ取得のページ構造を確認する（診断用）  node server/debug-delta.js <userId>
import { initDb } from './db.js'
import * as ms from './msgraph.js'
const db = await initDb()
const userId = Number(process.argv[2] || 3)
console.log('A) Prefer maxpagesize=999:', await ms.debugDelta(db, userId, { prefer: 'odata.maxpagesize=999', maxPages: 2 }))
console.log('B) $top=500:', await ms.debugDelta(db, userId, { query: '?$top=500', maxPages: 2 }))
console.log('C) $deltatoken=latest:', await ms.debugDelta(db, userId, { query: '?$deltatoken=latest', maxPages: 2 }))
console.log('D) $filter status ne completed:', await ms.debugDelta(db, userId, { query: "?$filter=status%20ne%20'completed'", maxPages: 2 }))
await db.close()
