export const CATS = [
  { key: 'idea', label: 'アイデア', icon: 'ti-bulb' },
  { key: 'todo', label: 'やること', icon: 'ti-checkbox' },
  { key: 'schedule', label: '予定', icon: 'ti-calendar-event' },
  { key: 'shopping', label: '買い物', icon: 'ti-shopping-cart' },
  { key: 'search', label: '調べもの', icon: 'ti-world-search' },
]
export const CAT_MAP = Object.fromEntries(CATS.map((c) => [c.key, c]))
