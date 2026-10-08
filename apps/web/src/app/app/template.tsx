// Route transition for the signed-in app: each navigation re-mounts this wrapper and plays a soft rise-in.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
