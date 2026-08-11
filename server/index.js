import cors from 'cors'
import express from 'express'

const app = express()
app.use(cors())
app.use(express.json())
const products = [{ id: 1, name: 'Ceramic travel mug', sku: 'CTM-001', stock: 124, reorder: 30, price: 24, category: 'Drinkware' }, { id: 2, name: 'Canvas tote bag', sku: 'CTB-042', stock: 18, reorder: 25, price: 18, category: 'Bags' }]
const orders = [{ id: 'PO-1042', supplier: 'Northline Supply', status: 'Awaiting delivery', total: 1240, expected: 'Aug 18' }, { id: 'PO-1041', supplier: 'Paper & Co.', status: 'Draft', total: 680, expected: 'Aug 22' }]
const suppliers = [{ id: 'sup-01', name: 'Northline Supply', contact: 'orders@northline.demo', leadTime: '4 days' }, { id: 'sup-02', name: 'Paper & Co.', contact: 'team@paperco.demo', leadTime: '7 days' }]
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'shelf-sync-api' }))
app.get('/api/products', (_req, res) => res.json({ data: products }))
app.get('/api/orders', (_req, res) => res.json({ data: orders }))
app.get('/api/suppliers', (_req, res) => res.json({ data: suppliers }))
app.post('/api/products/:id/movements', (req, res) => { const product = products.find((item) => item.id === Number(req.params.id)); const quantity = Number(req.body.quantity); if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > product.stock) return res.status(422).json({ error: 'invalid_movement' }); product.stock -= quantity; res.status(201).json({ data: product }) })
app.listen(process.env.PORT ?? 4001, () => console.log('ShelfSync API listening on http://localhost:4001'))
