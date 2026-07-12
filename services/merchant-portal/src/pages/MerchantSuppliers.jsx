import { Truck } from 'lucide-react'

export default function MerchantSuppliers({ user }) {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <Truck className="w-6 h-6" />
          Suppliers
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Manage your supplier relationships
        </p>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center">
        <p className="text-slate-500 dark:text-slate-400">
          Supplier management coming soon.
        </p>
      </div>
    </div>
  )
}