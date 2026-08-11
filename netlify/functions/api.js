const orders = [
  { id: 'PO-1042', supplier: 'Northline Supply', status: 'Awaiting delivery', total: 1240, expected: 'Aug 18' },
  { id: 'PO-1041', supplier: 'Paper & Co.', status: 'Draft', total: 680, expected: 'Aug 22' },
]

const suppliers = [
  { id: 'sup-01', name: 'Northline Supply', contact: 'orders@northline.demo', leadTime: '4 days' },
  { id: 'sup-02', name: 'Paper & Co.', contact: 'team@paperco.demo', leadTime: '7 days' },
]

export default async (request) => {
  const { pathname } = new URL(request.url)
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { 'content-type': 'application/json' } })
  if (pathname === '/api/orders') return Response.json({ data: orders })
  if (pathname === '/api/suppliers') return Response.json({ data: suppliers })
  return Response.json({ error: 'not_found' }, { status: 404 })
}

export const config = { path: '/api/*' }
