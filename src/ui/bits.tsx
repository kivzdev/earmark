import type { ReactNode } from 'react'
import { Skel } from './Skeleton'

// The pieces every page is built from — kivz.dev's: a header block (title in white, its line in grey), a section label
// over its content, and the ruled table (a label column, rows ruled across, the rest dimmed under the pointer).

export function Head({ title, lead }: { title: ReactNode; lead?: ReactNode }) {
  return (
    <header className="hello">
      <h1 data-in="col">{title}</h1>
      {lead && <p className="muted" data-in="col">{lead}</p>}
    </header>
  )
}

export function Section({ label, children, end }: { label: ReactNode; children: ReactNode; end?: ReactNode }) {
  return (
    <section className="block">
      <div className="label" data-in="col"><p className="muted">{label}</p>{end}</div>
      {children}
    </section>
  )
}

export const Table = ({ children }: { children: ReactNode }) => <ul className="years">{children}</ul>

/** one group of rows under its label (a year on kivz.dev's releases) */
export function Rows({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <li className="year" data-in="col">
      <span className="y muted"><span className="y-text">{label}</span></span>
      <ul className="items">{children}</ul>
    </li>
  )
}

/** a page whose data is still on its way: its header and a few rows in their own shape */
export function Waiting({ title }: { title: string }) {
  return (
    <div className="page">
      <Head title={title} lead={<Skel w={180} />} />
      <section className="block">
        <Table>
          {[0, 1, 2].map(i => (
            <Rows key={i} label={<Skel w={56} i={i} />}>
              <li><span className="row"><Skel w={260 - i * 40} i={i} /><Skel w={40} i={i} /></span></li>
            </Rows>
          ))}
        </Table>
      </section>
    </div>
  )
}
