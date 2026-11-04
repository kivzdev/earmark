import type { ReactNode } from 'react'
import { parts, type Catch } from '@/data'
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

/** a sentence as it was heard: its phrases in white, the rest of it grey (one catch, or several of the same sentence) */
export function Said({ c, also = [] }: { c: Catch; also?: Catch[] }) {
  if (!also.length) {
    const [a, p, b] = parts(c)
    return <span className="said"><span className="muted">{a}</span>{p}<span className="muted">{b}</span></span>
  }
  const lit = new Array<boolean>(c.sentence.length).fill(false)
  for (const x of [c, ...also]) for (let i = x.match[0]; i < x.match[1]; i++) lit[i] = true
  const out: { text: string; on: boolean }[] = []
  for (let i = 0; i < c.sentence.length; i++) {
    const last = out[out.length - 1]
    if (last && last.on === lit[i]) last.text += c.sentence[i]
    else out.push({ text: c.sentence[i], on: lit[i] })
  }
  return <span className="said">{out.map((r, i) => r.on ? r.text : <span key={i} className="muted">{r.text}</span>)}</span>
}

/** catches grouped by the sentence they came from (a sentence can hold several phrases), in the order given */
export function bySentence<T extends Catch>(list: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const c of list) {
    const key = `${c.sessionId}\u0000${c.sentence}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(c)
  }
  return [...groups.values()]
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
