import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="empty stack" style={{ justifyItems: 'center', paddingTop: '4rem' }}>
      <div style={{ fontSize: '4rem' }} className="main">
        404
      </div>
      <div className="sub">this page got scrambled.</div>
      <Link to="/" className="btn">
        back to the timer
      </Link>
    </div>
  );
}
