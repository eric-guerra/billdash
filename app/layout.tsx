import './globals.css';

export const metadata = { title: 'BillDash' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body className="bg-slate-50 text-slate-900 antialiased">{children}</body></html>;
}
