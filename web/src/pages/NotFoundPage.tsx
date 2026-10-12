import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div style={{ textAlign: 'center', paddingTop: '4rem' }}>
      <div style={{ fontSize: '4rem' }}>404</div>
      <p>this page got scrambled.</p>
      <Link to="/">back to the start page</Link>
    </div>
  );
}
