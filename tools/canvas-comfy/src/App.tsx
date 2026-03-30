import { InfiniteCanvas } from './canvas/InfiniteCanvas'
import { GeneratePanel } from './components/GeneratePanel'

export default function App() {
  return (
    <>
      <InfiniteCanvas />
      <GeneratePanel />
      <style>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </>
  )
}
