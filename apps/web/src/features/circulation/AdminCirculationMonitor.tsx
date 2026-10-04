import { AlertTriangle, BookOpen, BookText, CalendarClock, CheckCircle2, QrCode, RefreshCw, ScanBarcode, UserCircle } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, ConfirmModal, PageHeader, SectionCard, StatCard, StatusBadge } from '../../components/ui'
import { attendanceApi } from '../attendance/attendance-api'
import { catalogApi } from '../catalog/catalog-api'
import { usersApi } from '../users/users-api'
import { CancelBorrowRequestDialog } from './CancelBorrowRequestDialog'
import { CirculationScannerModal } from './CirculationScannerModal'
import { ReportLostDialog } from './ReportLostDialog'
import { circulationApi } from './circulation-api'
import type { CirculationMonitorData } from './types'

type MonitorItem = CirculationMonitorData['items'][number]
type StudentInfo = { name: string; role: string; program: string; avatarUrl: string | null }
type BookInfo = { title: string; authors: string; coverUrl: string | null }

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function extractBookCode(raw: string) {
  const data = raw.trim()
  if (data.startsWith('{')) {
    try {
      const parsed = JSON.parse(data) as { barcode?: string; accession_number?: string }
      return (parsed.accession_number || parsed.barcode || '').trim()
    } catch {
      return ''
    }
  }
  if (data.startsWith('ACC-') || data.startsWith('BC-') || data.includes('-IMP-')) return data
  return ''
}

export function AdminCirculationMonitor() {
  const [data, setData] = useState<CirculationMonitorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [barcode, setBarcode] = useState('')
  const [schoolId, setSchoolId] = useState('')
  const [studentInfo, setStudentInfo] = useState<StudentInfo | null>(null)
  const [bookInfo, setBookInfo] = useState<BookInfo | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [showConfirmCheckout, setShowConfirmCheckout] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<MonitorItem | null>(null)
  const [returnTarget, setReturnTarget] = useState<MonitorItem | null>(null)
  const [cancelError, setCancelError] = useState('')
  const [lostTarget, setLostTarget] = useState<MonitorItem | null>(null)
  const [lostError, setLostError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await circulationApi.monitor())
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Circulation records are unavailable.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const refresh = () => void load()
    const timer = window.setInterval(refresh, 5_000)
    window.addEventListener('smartlib:circulation-updated', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('smartlib:circulation-updated', refresh)
    }
  }, [load])

  function clearTerminal() {
    setBarcode('')
    setSchoolId('')
    setStudentInfo(null)
    setBookInfo(null)
    setError('')
    setSuccess('')
    setShowConfirmCheckout(false)
  }

  async function loadBookPreview(code: string) {
    const pendingMatch = data?.items.find((item) => item.barcode === code || item.accessionNumber === code)
    if (pendingMatch) {
      setBookInfo({ title: pendingMatch.title, authors: '', coverUrl: null })
      return
    }
    try {
      const label = await catalogApi.copyByBarcode(code)
      setBookInfo({ title: label.title, authors: label.author, coverUrl: null })
    } catch {
      setBookInfo({ title: code, authors: 'Book details unavailable', coverUrl: null })
    }
  }

  async function handleScan(raw: string) {
    setShowScanner(false)
    setError('')
    setSuccess('')
    const dataText = raw.trim()
    if (!dataText) return

    const bookCode = extractBookCode(dataText)
    if (bookCode) {
      setBarcode(bookCode)
      await loadBookPreview(bookCode)
      setSuccess('Book scanned successfully. Scan student ID next, or confirm checkout.')
      return
    }

    if (dataText.startsWith('STILIB.ATTENDANCE.')) {
      setSubmitting(true)
      try {
        const result = await attendanceApi.resolveScan(dataText)
        setSchoolId(result.visitor.schoolId)
        let avatarUrl: string | null = null
        try {
          avatarUrl = (await usersApi.getAvatar(result.visitor.schoolId)).avatarUrl
        } catch {
          avatarUrl = null
        }
        setStudentInfo({
          name: result.visitor.name,
          role: result.visitor.role,
          program: result.visitor.program ?? '',
          avatarUrl,
        })
        setSuccess('Student verified. Scan book next, or confirm checkout.')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid student QR code.')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (dataText.includes('-')) {
      setSchoolId(dataText.toUpperCase())
      const pendingMatch = data?.items.find((item) => item.schoolId.toUpperCase() === dataText.toUpperCase())
      setStudentInfo(pendingMatch
        ? { name: pendingMatch.userName, role: pendingMatch.role, program: '', avatarUrl: null }
        : { name: dataText.toUpperCase(), role: 'Borrower', program: '', avatarUrl: null })
      setSuccess('School ID logged. Scan book next, or confirm checkout.')
      return
    }

    setError('Unrecognized QR payload. Scan a student attendance QR or a book accession QR.')
  }

  async function handleReturnScan(raw: string) {
    if (!returnTarget) return
    setError('')
    setSuccess('')

    const scannedBarcode = extractBookCode(raw) || raw.trim()
    const expected = [returnTarget.barcode, returnTarget.accessionNumber].filter(Boolean) as string[]
    const matched = expected.some((value) => value === scannedBarcode)

    if (!matched) {
      setError(`Barcode mismatch! Expected ${returnTarget.barcode}, but scanned ${scannedBarcode || '(empty)'}. This is the wrong book.`)
      setReturnTarget(null)
      return
    }

    const tid = returnTarget.transactionId
    setReturnTarget(null)
    setBusyId(tid)
    try {
      await circulationApi.returnBook(tid)
      setSuccess('Return completed and the waiting queue was advanced.')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Return could not be completed.')
    } finally {
      setBusyId(null)
    }
  }

  function promptCheckout(event: FormEvent) {
    event.preventDefault()
    if (!schoolId.trim() || !barcode.trim()) return
    setShowConfirmCheckout(true)
  }

  async function checkout() {
    if (submitting) return
    setSubmitting(true)
    setError('')
    setSuccess('')
    try {
      await circulationApi.confirmCheckout(barcode.trim(), schoolId.trim())
      clearTerminal()
      setSuccess('Checkout confirmed successfully. The book is now an active loan.')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Checkout could not be confirmed.')
      setShowConfirmCheckout(false)
    } finally {
      setSubmitting(false)
    }
  }

  async function penalty(transactionId: number) {
    setBusyId(transactionId)
    setError('')
    setSuccess('')
    try {
      const result = await circulationApi.calculatePenalty(transactionId)
      setSuccess(`Calculated penalty: ₱${result.amount.toFixed(2)}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Penalty could not be calculated.')
    } finally {
      setBusyId(null)
    }
  }

  async function cancelPending(reason: string) {
    if (!cancelTarget || busyId !== null) return
    const target = cancelTarget
    setBusyId(target.transactionId)
    setCancelError('')
    setError('')
    setSuccess('')
    try {
      await circulationApi.cancelRequest(target.transactionId, reason)
      setData((current) => current ? {
        ...current,
        summary: { ...current.summary, pendingClaims: Math.max(0, current.summary.pendingClaims - 1) },
        items: current.items.filter((item) => item.transactionId !== target.transactionId),
      } : current)
      setCancelTarget(null)
      setSuccess(`${target.title} pending claim was cancelled and released.`)
      window.dispatchEvent(new Event('smartlib:circulation-updated'))
      await load()
    } catch (reasonValue) {
      setCancelError(reasonValue instanceof Error ? reasonValue.message : 'The pending request could not be cancelled.')
    } finally {
      setBusyId(null)
    }
  }

  async function reportLost() {
    if (!lostTarget || busyId !== null) return
    setBusyId(lostTarget.transactionId)
    setLostError('')
    setError('')
    setSuccess('')
    try {
      const result = await circulationApi.reportLost(lostTarget.transactionId)
      setSuccess(result.alreadyReported
        ? 'This loss is already awaiting staff review.'
        : 'Loss reported and borrower notified. Review it in Admin clearance.')
      setLostTarget(null)
      await load()
    } catch (reason) {
      setLostError(reason instanceof Error ? reason.message : 'The loss could not be reported.')
    } finally {
      setBusyId(null)
    }
  }

  function loadPendingClaim(item: MonitorItem) {
    setSchoolId(item.schoolId)
    setBarcode(item.barcode)
    setStudentInfo({ name: item.userName, role: item.role, program: '', avatarUrl: null })
    setBookInfo({ title: item.title, authors: '', coverUrl: null })
    setError('')
    setSuccess('Student and book loaded from pending claim. Confirm checkout after verifying the presented ID and book.')
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const lanes = useMemo(() => ({
    pending: data?.items.filter((item) => item.status === 'Pending') ?? [],
    active: data?.items.filter((item) => ['Borrowed', 'Active'].includes(item.status)) ?? [],
    overdue: data?.items.filter((item) => item.status === 'Overdue') ?? [],
  }), [data])

  const table = (items: MonitorItem[], empty: string) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-left text-sm">
        <thead className="bg-[#0b5ea2] text-[#FFFFFF]">
          <tr>
            <th className="px-4 py-3">Borrower</th>
            <th className="px-4 py-3">Book / copy</th>
            <th className="px-4 py-3">Requested / borrowed</th>
            <th className="px-4 py-3">Due</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.length ? items.map((item) => (
            <tr key={item.transactionId} className="border-b border-[#0b5ea2]/10">
              <td className="px-4 py-4">
                <p className="font-bold text-[#0b5ea2]">{item.userName}</p>
                <p className="text-xs text-[#0b5ea2]/60">{item.schoolId} · {item.role}</p>
              </td>
              <td className="px-4 py-4">
                <p className="font-bold text-[#0b5ea2]">{item.title}</p>
                <p className="font-mono text-xs text-[#0b5ea2]/60">{item.accessionNumber ?? item.barcode}</p>
              </td>
              <td className="px-4 py-4 text-xs text-[#0b5ea2]">{formatDate(item.borrowDate ?? item.requestedAt)}</td>
              <td className="px-4 py-4 text-xs font-semibold text-[#0b5ea2]">{formatDate(item.dueDate)}</td>
              <td className="px-4 py-4"><StatusBadge status={item.status === 'Pending' ? 'Pending claim' : item.status} /></td>
              <td className="px-4 py-4">
                <div className="flex justify-end gap-2">
                  {item.status === 'Pending' ? (
                    <>
                      <button type="button" onClick={() => loadPendingClaim(item)} className="rounded-lg border border-[#0b5ea2]/20 bg-[#FFFFFF] px-3 py-2 text-xs font-bold text-[#0b5ea2]">Verify borrower</button>
                      <button type="button" disabled={busyId === item.transactionId} onClick={() => { setCancelError(''); setCancelTarget(item) }} className="rounded-lg border border-[#0b5ea2]/20 bg-[#FFFFFF] px-3 py-2 text-xs font-bold text-[#0b5ea2] disabled:opacity-40">Cancel</button>
                    </>
                  ) : (
                    <>
                      {item.status === 'Overdue' ? (
                        <button type="button" disabled={busyId === item.transactionId} onClick={() => void penalty(item.transactionId)} className="rounded-lg bg-[#FFF200] px-3 py-2 text-xs font-bold text-[#0b5ea2] disabled:opacity-40">Calculate penalty</button>
                      ) : null}
                      <button type="button" disabled={busyId === item.transactionId} onClick={() => { setLostError(''); setLostTarget(item) }} className="rounded-lg border border-[#0b5ea2]/20 px-3 py-2 text-xs font-bold text-[#0b5ea2] disabled:opacity-40">Report lost</button>
                      <button type="button" disabled={busyId === item.transactionId} onClick={() => setReturnTarget(item)} className="rounded-lg bg-[#0b5ea2] px-3 py-2 text-xs font-bold text-[#FFFFFF] disabled:opacity-40">Process return</button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          )) : (
            <tr><td colSpan={6} className="px-4 py-10 text-center font-semibold text-[#0b5ea2]">{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )

  return <>
    <PageHeader eyebrow="Circulation desk" title="Borrow and return monitoring" action={<Button variant="secondary" onClick={() => void load()}><RefreshCw size={16} /> Refresh</Button>} />
    {error ? <div role="alert" className="mb-4 flex items-center gap-3 rounded-xl bg-[#FFF200] px-4 py-3 font-semibold text-[#0b5ea2]"><AlertTriangle size={18} />{error}</div> : null}
    {success ? <div role="status" className="mb-4 flex items-center gap-3 rounded-xl border border-[#0b5ea2]/20 bg-[#FFFFFF] px-4 py-3 font-semibold text-[#0b5ea2]"><CheckCircle2 size={18} />{success}</div> : null}

    <div className="mb-5 flex flex-col gap-5 xl:flex-row">
      <div className="relative flex w-full flex-col gap-4 overflow-hidden rounded-3xl border border-[#0b5ea2]/15 bg-white p-6 shadow-sm xl:w-1/3">
        <div className="absolute -right-10 -top-10 text-[#0b5ea2]/5"><QrCode size={180} /></div>
        <div className="relative z-10 flex h-full flex-col justify-between">
          <div>
            <h2 className="font-display text-xl font-bold text-[#0b5ea2]">Checkout Terminal</h2>
            <p className="mt-1 text-sm text-[#0b5ea2]/70">Open the webcam to scan the student ID and book QR in any order, or enter values manually.</p>
          </div>
          <button
            type="button"
            onClick={() => setShowScanner(true)}
            className="mt-6 flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-[#0b5ea2] text-lg font-bold text-white shadow-md transition-all hover:bg-[#004488]"
          >
            <QrCode size={24} />
            Open Scanner
          </button>
        </div>
      </div>

      <div className="flex-1 rounded-3xl border border-[#0b5ea2]/15 bg-white p-6 shadow-sm">
        <form onSubmit={promptCheckout} className="flex h-full flex-col justify-between gap-5">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-2xl border border-[#0b5ea2]/10 bg-zinc-50 p-4">
              <div className="flex items-center gap-4">
                {studentInfo?.avatarUrl ? (
                  <img src={studentInfo.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover shadow-sm" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#0b5ea2]/10 text-[#0b5ea2]">
                    <UserCircle size={32} />
                  </div>
                )}
                <div className="min-w-0 flex-1 overflow-hidden">
                  {studentInfo ? (
                    <>
                      <h3 className="truncate font-bold text-[#0b5ea2]">{studentInfo.name}</h3>
                      <p className="truncate text-xs font-semibold text-[#0b5ea2]/70">{schoolId} · {studentInfo.role}</p>
                      {studentInfo.program ? <p className="truncate text-xs text-[#0b5ea2]/60">{studentInfo.program}</p> : null}
                    </>
                  ) : (
                    <h3 className="font-semibold italic text-[#0b5ea2]/50">Waiting for student scan…</h3>
                  )}
                </div>
              </div>
              <input
                required
                value={schoolId}
                onChange={(event) => setSchoolId(event.target.value)}
                placeholder="Manual School ID e.g. 09-0123"
                className="h-10 w-full rounded-xl border border-[#0b5ea2]/20 bg-white px-3 font-mono text-sm font-bold text-[#0b5ea2] outline-none focus:ring-2 focus:ring-[#0b5ea2]/10"
              />
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-[#0b5ea2]/10 bg-zinc-50 p-4">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-[#0b5ea2]/10 text-[#0b5ea2]">
                  <BookText size={32} />
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  {bookInfo ? (
                    <>
                      <h3 className="truncate font-bold text-[#0b5ea2]">{bookInfo.title}</h3>
                      <p className="truncate text-xs text-[#0b5ea2]/70">{bookInfo.authors}</p>
                      <p className="mt-1 truncate text-xs font-bold text-[#0b5ea2]/60">{barcode}</p>
                    </>
                  ) : (
                    <h3 className="font-semibold italic text-[#0b5ea2]/50">Waiting for book scan…</h3>
                  )}
                </div>
              </div>
              <input
                required
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                placeholder="Manual Accession e.g. ACC-123"
                className="h-10 w-full rounded-xl border border-[#0b5ea2]/20 bg-white px-3 font-mono text-sm font-bold text-[#0b5ea2] outline-none focus:ring-2 focus:ring-[#0b5ea2]/10"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-[#0b5ea2]/10 pt-4">
            <button type="button" onClick={clearTerminal} className="rounded-xl px-5 py-3 font-bold text-[#0b5ea2] hover:bg-zinc-100">Clear</button>
            <button
              type="submit"
              disabled={submitting || !schoolId.trim() || !barcode.trim()}
              className="flex items-center gap-2 rounded-xl bg-[#0b5ea2] px-8 py-3 text-lg font-bold text-white shadow-md hover:bg-[#004488] disabled:opacity-50"
            >
              {submitting ? 'Confirming…' : <><ScanBarcode size={20} /> Confirm Checkout</>}
            </button>
          </div>
        </form>
      </div>
    </div>

    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard label="Pending claim" value={data?.summary.pendingClaims ?? 0} icon={ScanBarcode} tone="orange" />
      <StatCard label="Active claims" value={data?.summary.activeLoans ?? 0} icon={BookOpen} tone="blue" />
      <StatCard label="Due today" value={data?.summary.dueToday ?? 0} icon={CalendarClock} tone="orange" />
      <StatCard label="Overdue" value={data?.summary.overdueLoans ?? 0} icon={AlertTriangle} tone="red" />
      <StatCard label="Returned today" value={data?.summary.returnedToday ?? 0} icon={CheckCircle2} tone="blue" />
    </div>

    {loading && !data ? (
      <SectionCard className="p-10 text-center font-semibold text-[#0b5ea2]">Loading circulation monitor…</SectionCard>
    ) : (
      <div className="space-y-5">
        <SectionCard className="overflow-hidden">
          <div className="border-b border-[#0b5ea2]/15 px-5 py-4"><h2 className="font-bold text-[#0b5ea2]">Online carts pending counter claim</h2></div>
          {table(lanes.pending, 'No students are currently on the way to claim books.')}
        </SectionCard>
        <SectionCard className="overflow-hidden">
          <div className="border-b border-[#0b5ea2]/15 px-5 py-4"><h2 className="font-bold text-[#0b5ea2]">Active material claims waiting for return</h2></div>
          {table(lanes.active, 'No active claims.')}
        </SectionCard>
        <SectionCard className="overflow-hidden">
          <div className="border-b border-[#0b5ea2]/15 px-5 py-4"><h2 className="font-bold text-[#0b5ea2]">Overdue records</h2></div>
          {table(lanes.overdue, 'No overdue records.')}
        </SectionCard>
      </div>
    )}

    {showConfirmCheckout ? (
      <ConfirmModal
        title="Confirm Checkout"
        description={`Check out ${bookInfo?.title || barcode} to ${studentInfo?.name || schoolId}?`}
        confirmText={submitting ? 'Confirming…' : 'Yes, Check Out'}
        cancelText="Cancel"
        onCancel={() => { if (!submitting) setShowConfirmCheckout(false) }}
        onConfirm={() => void checkout()}
      />
    ) : null}

    {showScanner ? (
      <CirculationScannerModal onClose={() => setShowScanner(false)} onScan={(value) => void handleScan(value)} />
    ) : null}

    {returnTarget ? (
      <CirculationScannerModal onClose={() => setReturnTarget(null)} onScan={(value) => void handleReturnScan(value)} />
    ) : null}

    {cancelTarget ? (
      <CancelBorrowRequestDialog
        title={cancelTarget.title}
        busy={busyId === cancelTarget.transactionId}
        error={cancelError}
        onCancel={() => { if (busyId === null) setCancelTarget(null) }}
        onConfirm={(reason) => void cancelPending(reason)}
      />
    ) : null}

    {lostTarget ? (
      <ReportLostDialog
        title={lostTarget.title}
        busy={busyId === lostTarget.transactionId}
        error={lostError}
        onCancel={() => { if (busyId === null) setLostTarget(null) }}
        onConfirm={() => void reportLost()}
      />
    ) : null}
  </>
}
