import { useEffect, useRef, useState } from 'react'
import { QrCode, X, AlertTriangle } from 'lucide-react'
import { Html5Qrcode } from 'html5-qrcode'

interface Props {
  onScan: (data: string) => void
  onClose: () => void
}

export function CirculationScannerModal({ onScan, onClose }: Props) {
  const containerId = 'circulation-qr-reader'
  const [error, setError] = useState('')
  const [initializing, setInitializing] = useState(true)
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const isScanning = useRef(false)

    const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  useEffect(() => {
    let mounted = true
    const initScanner = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        stream.getTracks().forEach(t => t.stop())
        if (!mounted) return
        
        const html5QrCode = new Html5Qrcode(containerId)
        scannerRef.current = html5QrCode
        
        await html5QrCode.start(
          { facingMode: 'environment' },
          { fps: 10, aspectRatio: 1.0, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            if (isScanning.current) return
            isScanning.current = true
            html5QrCode.stop().then(() => {
              onScanRef.current(decodedText)
            }).catch(console.error)
          },
          () => {}
        )
        if (mounted) setInitializing(false)
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Camera access denied or not available.')
          setInitializing(false)
        }
      }
    }
    
    initScanner()

    return () => {
      mounted = false
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(console.error)
      }
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[999] lg:left-[var(--sidebar-offset,0px)] flex items-center justify-center bg-[#0b5ea2]/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-3xl bg-[#FFFFFF] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#0b5ea2]/10 bg-[#FFFFFF] px-6 py-4">
          <div className="flex items-center gap-2 font-display text-lg font-bold text-[#0b5ea2]">
            <QrCode size={20} />
            Scan QR Code
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-[#0b5ea2]/60 hover:bg-[#0b5ea2]/5 hover:text-[#0b5ea2]">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-6 relative">
          <p className="mb-4 text-center text-sm font-semibold text-[#0b5ea2]/70">
            Hold a Student School ID or Book QR up to the camera
          </p>
          
          <div className="overflow-hidden rounded-2xl bg-black">
            {error ? (
              <div className="flex aspect-square flex-col items-center justify-center p-6 text-center">
                <AlertTriangle className="mb-2 text-red-500" size={32} />
                <p className="text-sm font-bold text-red-500">Camera Error</p>
                <p className="mt-1 text-xs text-white/70">{error}</p>
              </div>
            ) : (
              <div id={containerId} className="w-full [&_video]:w-full [&_video]:object-cover" />
            )}
          </div>
          
          {initializing && !error ? (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm z-10">
              <p className="font-bold text-[#0b5ea2] animate-pulse">Starting camera...</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
