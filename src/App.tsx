import { useMemo, useState } from 'react'
import { Barcode, Boxes, ChevronDown, ClipboardList, Download, LayoutDashboard, Plus, Search, ShoppingCart, Wifi, WifiOff } from 'lucide-react'
import './App.css'

type Product = { id: number; name: string; sku: string; stock: number; reorder: number; price: number; category: string }
const seedProducts: Product[] = [
  { id: 1, name: 'Ceramic travel mug', sku: 'CTM-001', stock: 124, reorder: 30, price: 24, category: 'Drinkware' },
  { id: 2, name: 'Canvas tote bag', sku: 'CTB-042', stock: 18, reorder: 25, price: 18, category: 'Bags' },
  { id: 3, name: 'Minimal notebook', sku: 'MN-104', stock: 86, reorder: 40, price: 12, category: 'Stationery' },
  { id: 4, name: 'Desk organizer', sku: 'DO-221', stock: 7, reorder: 20, price: 36, category: 'Office' },
]

function App() {
  const [products, setProducts] = useState(seedProducts)
  const [search, setSearch] = useState('')
  const [online, setOnline] = useState(true)
  const [movementOpen, setMovementOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(1)
  const [quantity, setQuantity] = useState(1)
  const [toast, setToast] = useState('')
  const filtered = useMemo(() => products.filter((product) => product.name.toLowerCase().includes(search.toLowerCase()) || product.sku.toLowerCase().includes(search.toLowerCase())), [products, search])
  const lowStock = products.filter((product) => product.stock <= product.reorder)
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2400) }
  const saveMovement = () => { setProducts((items) => items.map((item) => item.id === selectedId ? { ...item, stock: Math.max(0, item.stock - quantity) } : item)); setMovementOpen(false); notify(online ? 'Stock movement synced' : 'Movement queued for sync') }
  return <main className="shelf-app"><aside><div className="logo"><Boxes />ShelfSync</div><div className="workspace"><span>NS</span><b>Northstar Retail</b><ChevronDown size={16}/></div>{[[LayoutDashboard,'Overview'],[Boxes,'Inventory'],[ShoppingCart,'Orders'],[ClipboardList,'Reports']].map(([Icon,label]) => <button className={label === 'Inventory' ? 'active' : ''} key={String(label)}><Icon size={18}/>{String(label)}</button>)}<div className="aside-bottom"><button onClick={() => setOnline(!online)}>{online ? <Wifi size={18}/> : <WifiOff size={18}/>}<span>{online ? 'Online · synced' : 'Offline · 0 queued'}</span></button><small>Workspace owner<br/><b>Tariq Ali</b></small></div></aside><section><header><label><Search size={18}/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="Search products or SKU"/></label><button className="export" onClick={()=>notify('Inventory export prepared')}><Download size={17}/>Export</button><button className="primary" onClick={()=>setMovementOpen(true)}><Plus size={17}/>Record movement</button></header><div className="page"><div className="eyebrow">INVENTORY / ALL PRODUCTS</div><h1>Inventory overview</h1><p>Track stock accurately across your workspace, even when connectivity changes.</p><div className="stats"><article><small>Total products</small><strong>{products.length}</strong><span>Across 4 categories</span></article><article><small>Units in stock</small><strong>{products.reduce((sum,p)=>sum+p.stock,0)}</strong><span>Updated just now</span></article><article className="attention"><small>Low-stock alerts</small><strong>{lowStock.length}</strong><span>Needs attention</span></article><article><small>Inventory value</small><strong>${products.reduce((sum,p)=>sum+p.stock*p.price,0).toLocaleString()}</strong><span>At retail value</span></article></div><div className="content-card"><div className="card-head"><div><h2>Products</h2><span>{filtered.length} results</span></div><button onClick={()=>notify('Barcode scanner ready for a supported camera') }><Barcode size={16}/>Scan barcode</button></div><div className="table"><div className="table-head"><span>Product</span><span>SKU</span><span>Category</span><span>In stock</span><span>Price</span></div>{filtered.map((p)=><button key={p.id} onClick={()=>{setSelectedId(p.id);setMovementOpen(true)}}><span><i className={p.stock<=p.reorder?'warn':''}/><b>{p.name}</b></span><span>{p.sku}</span><span>{p.category}</span><span className={p.stock<=p.reorder?'low':''}>{p.stock} <small>reorder at {p.reorder}</small></span><span>${p.price}.00</span></button>)}</div></div></div></section>{movementOpen&&<div className="modal-wrap"><form className="modal" onSubmit={(e)=>{e.preventDefault();saveMovement()}}><h2>Record stock movement</h2><p>Decrease available stock for a sale, adjustment, or transfer.</p><label>Product<select value={selectedId} onChange={(e)=>setSelectedId(Number(e.target.value))}>{products.map(p=><option key={p.id} value={p.id}>{p.name} ({p.stock} available)</option>)}</select></label><label>Quantity<input type="number" min="1" value={quantity} onChange={(e)=>setQuantity(Number(e.target.value))}/></label><div><button type="button" onClick={()=>setMovementOpen(false)}>Cancel</button><button className="primary" type="submit">Save movement</button></div></form></div>}{toast&&<div className="toast">{toast}</div>}</main>
}
export default App
