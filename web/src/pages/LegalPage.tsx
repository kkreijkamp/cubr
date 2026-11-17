// The terms of service and privacy policy (/terms, /privacy). Plain text on purpose: what cubr
// collects and why, in the same voice as the rest of the site. Keep them in step with what the
// services actually do (retention, providers, what a private profile hides).
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DocumentTextIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import './legal.css';
import { useCanonical } from '../lib/canonical';

// when each page last changed
const TERMS_EFFECTIVE = '16 November 2026';
const PRIVACY_EFFECTIVE = '18 November 2026'; // v1.5.0: sign-in with Google, Apple and GitHub; Cloudflare Web Analytics; error reports; the emails that confirm an address
const CONTACT = 'hello@cubr.dev';

const Mail = () => <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="legal-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function LegalShell({ title, icon, children, effective }: { title: string; icon: ReactNode; children: ReactNode; effective: string }) {
  useEffect(() => {
    document.title = `${title} | cubr`;
    window.scrollTo(0, 0);
    return () => {
      document.title = 'cubr';
    };
  }, [title]);
  return (
    <article className="legal">
      <header>
        <h1 className="h2">
          {icon} {title}
        </h1>
        <p className="legal-meta">
          effective {effective} - questions: <Mail />
        </p>
      </header>
      {children}
    </article>
  );
}

export function PrivacyPage() {
  useCanonical('/privacy');
  return (
    <LegalShell title="privacy policy" effective={PRIVACY_EFFECTIVE} icon={<ShieldCheckIcon />}>
      <p className="legal-intro">
        cubr (cubr.dev) is a free speedcubing timer run by Koen Kreijkamp, an individual in Queensland, Australia (&quot;cubr&quot;,
        &quot;we&quot;). This policy explains what we collect, why, who helps us run cubr, and the choices you have. There are no ads,
        and nothing follows you around the web: the only measurement is Cloudflare Web Analytics, which counts page views without
        cookies.
      </p>

      <Section title="what we collect">
        <ul>
          <li>
            <b>Account:</b> your username, email address (and whether you&apos;ve confirmed it) and password. The password is stored only as a bcrypt hash, so we can&apos;t
            read it.
          </li>
          <li>
            <b>Sign-in with Google, Apple or GitHub</b> (if you choose it): your account&apos;s id there and its verified email address.
            When you sign up this way, your name there suggests a username and isn&apos;t kept. We never see your password for that
            account. An account made this way has no password until you set one.
          </li>
          <li>
            <b>Profile</b> (all optional): display name, bio, country, WCA ID and profile picture.
          </li>
          <li>
            <b>Your cubing:</b> solves (times, penalties, scrambles, comments and dates), sessions, daily-challenge attempts and your
            settings.
          </li>
          <li>
            <b>Race rooms:</b> the name you race under and the chat messages you send, kept for 2 hours.
          </li>
          <li>
            <b>Technical data:</b> your IP address, used for the rate limits that protect sign-in and the rest of the service, and in our
            server logs. Cloudflare, which sits in front of cubr, also handles your IP address and request details.
          </li>
          <li>
            <b>Page views:</b> Cloudflare Web Analytics records the page you open, the page that linked to it, your browser and device
            type, your country (worked out from your IP address, which it doesn&apos;t keep) and how fast the page loaded. Cloudflare says
            it uses no cookies or other storage in your browser for this and doesn&apos;t fingerprint visitors. We only see totals, never
            a record of one visit. If your browser sends Global Privacy Control or Do Not Track, cubr doesn&apos;t load it.
          </li>
          <li>
            <b>Error reports:</b> if something in cubr breaks while you use it, your browser sends us the error: its message and where in
            cubr&apos;s code it happened, the kind of page (such as &quot;a profile&quot;, never which one), whether you use the installed
            app, and your browser&apos;s name and version. Anything in it that looks personal, such as an email address or a username, is
            taken out first. Reports aren&apos;t linked to your account, and we don&apos;t keep your IP address with them.
          </li>
          <li>
            <b>Emails</b> you send to <Mail />.
          </li>
          <li>
            <b>Supporters:</b> if you support cubr on Ko-fi, Ko-fi tells us the kind of support, when, and your name if you made your
            support public. We keep only that; not your email, message, amount or payment details.
          </li>
          <li>
            <b>Guests:</b> without an account, your solves and settings stay in your browser and never reach our servers, unless you
            sign in and choose to upload them.
          </li>
        </ul>
      </Section>

      <Section title="what is public">
        <ul>
          <li>Your username and profile picture are always public: on your profile, the leaderboards, the daily-challenge board and in race rooms.</li>
          <li>
            With a public profile (the default), anyone can also see your display name, bio, country, WCA ID, statistics, solve history,
            activity and leaderboard ranks.
          </li>
          <li>If you support cubr on Ko-fi and make your support public, your Ko-fi name appears on the about page.</li>
          <li>
            With a private profile, everyone else sees only your username and picture. Your times still appear on the leaderboards and the
            daily-challenge board under your username.
          </li>
          <li>
            You can switch between the two at any time: <Link to="/account">account</Link> &gt; edit profile.
          </li>
        </ul>
      </Section>

      <Section title="why we use it">
        <ul>
          <li>
            To run the service you signed up for: your account, syncing your solves, profiles, leaderboards, the daily challenge, races and
            password-reset emails, the emails that confirm your email address (when you sign up or change it), and the notice to your old
            address after a change. (Legal basis: performing our agreement
            with you.)
          </li>
          <li>
            To keep cubr safe, fair and working: rate limits, server logs, error reports, anti-cheat checks that compare times with WCA
            records, and backups. (Legal basis: our legitimate interest in running a secure service.)
          </li>
          <li>
            To see which pages are used and how fast they load, so we know what to improve: page-view totals from Cloudflare Web
            Analytics. (Legal basis: our legitimate interest in improving cubr.)
          </li>
          <li>To answer you when you contact us.</li>
        </ul>
        <p>We don&apos;t sell your data, use it for advertising, or build profiles of you.</p>
      </Section>

      <Section title="who helps us run cubr">
        <p>These providers process data for us only to provide their service:</p>
        <ul>
          <li>
            <b>Google Cloud:</b> our server (Sydney) and nightly backups (Melbourne), in Australia.
          </li>
          <li>
            <b>Cloudflare:</b> our domain, security and delivery. Your traffic passes through Cloudflare&apos;s global network, where it is
            decrypted to be protected and routed. Cloudflare also counts our page views (Web Analytics, above).
          </li>
          <li>
            <b>Resend:</b> sends password-reset emails and the emails that confirm an email address.
          </li>
          <li>
            <b>Apple iCloud:</b> hosts our contact inbox, <Mail />.
          </li>
          <li>
            <b>Ko-fi:</b> takes donations. The payment itself is between you and Ko-fi, under Ko-fi&apos;s own terms and privacy policy.
          </li>
          <li>
            <b>Google, Apple and GitHub:</b> if you sign in with one of them, it confirms who you are, under its own terms and privacy
            policy. We only receive what is listed above.
          </li>
        </ul>
        <p>Some of them are based in, or process data in, other countries, including the United States, under their own data processing terms.</p>
      </Section>

      <Section title="wca results">
        <p>
          The rankings and comparisons use public competition results from the World Cube Association: competitors&apos; names, WCA IDs,
          countries and results, updated weekly. This information is based on competition results owned and maintained by the World Cube
          Association, published at{' '}
          <a href="https://www.worldcubeassociation.org/results" target="_blank" rel="noreferrer noopener">
            worldcubeassociation.org/results
          </a>
          . To correct or remove WCA data, contact the WCA; the change reaches cubr with the next update. cubr is not affiliated with the WCA.
        </p>
      </Section>

      <Section title="cookies and local storage">
        <p>
          cubr sets one cookie of its own, and only while you sign in with Google, Apple or GitHub: it ties that sign-in to your browser
          and expires within minutes. Your browser&apos;s local storage keeps you signed in and holds your settings and offline solves,
          so the site works. None of it is used for tracking or advertising, which is why there is no cookie banner. Cloudflare may set a
          strictly necessary security cookie. Cloudflare Web Analytics sets none.
        </p>
      </Section>

      <Section title="how long we keep it">
        <ul>
          <li>
            Your account and solves: until you delete your account. Deleting removes them from the live database straight away, and from
            backups within 30 days.
          </li>
          <li>
            Password-reset links work for 1 hour, links that confirm your email for 7 days (1 hour for a change of address). Race chat is
            kept for 2 hours, and rate-limit counters for up to a day.
          </li>
          <li>Server logs, error reports included, are rotated automatically and overwritten as they fill up.</li>
          <li>Supporter entries: until you ask us to remove your name.</li>
          <li>Page-view statistics: only as totals, in Cloudflare&apos;s dashboard, for as long as Cloudflare keeps them.</li>
          <li>
            Emails to <Mail />: as long as needed to deal with them.
          </li>
        </ul>
      </Section>

      <Section title="your choices and rights">
        <ul>
          <li>
            Edit your profile or make it private: <Link to="/account">account</Link> &gt; edit profile.
          </li>
          <li>
            Download all your solves: <Link to="/settings#data">settings &gt; data</Link> &gt; export.
          </li>
          <li>
            Delete your account and solves: <Link to="/settings#danger">settings &gt; danger zone</Link>.
          </li>
          <li>
            For anything else (a copy of your data, a correction, deletion, or an objection to how we use it), email <Mail />. We reply
            within a month.
          </li>
          <li>If you are in the EU or UK, you can also complain to your local data protection authority; in Australia, to the OAIC.</li>
        </ul>
      </Section>

      <Section title="children">
        <p>
          cubr is for people aged 13 and over. If you are under 18, please use cubr with the permission of a parent or guardian. If we learn
          that an account belongs to someone under 13, we will delete it. Parents can reach us at <Mail />.
        </p>
      </Section>

      <Section title="security">
        <p>
          Traffic is encrypted (HTTPS), passwords are hashed with bcrypt, and access to our servers is restricted. No service is perfectly
          secure; if a breach affects your data, we will tell you without undue delay.
        </p>
      </Section>

      <Section title="changes">
        <p>If we change this policy, we will update the date at the top, and give notice on the site before significant changes.</p>
      </Section>

      <p className="legal-foot">
        Questions? <Mail />. See also the <Link to="/terms">terms of service</Link>.
      </p>
    </LegalShell>
  );
}

export function TermsPage() {
  useCanonical('/terms');
  return (
    <LegalShell title="terms of service" effective={TERMS_EFFECTIVE} icon={<DocumentTextIcon />}>
      <p className="legal-intro">
        These terms apply when you use cubr (cubr.dev), a free speedcubing timer run by Koen Kreijkamp in Queensland, Australia
        (&quot;cubr&quot;, &quot;we&quot;). By using cubr or creating an account, you agree to them and to our{' '}
        <Link to="/privacy">privacy policy</Link>. If you don&apos;t agree, please don&apos;t use cubr.
      </p>

      <Section title="who can use cubr">
        <p>You must be 13 or older. If you are under 18, you need the permission of a parent or guardian, who accepts these terms for you.</p>
      </Section>

      <Section title="your account">
        <ul>
          <li>Use a real email address you control: it is how you reset your password.</li>
          <li>Keep your password to yourself. You are responsible for what happens on your account.</li>
          <li>One person per account. Don&apos;t impersonate anyone; we may change usernames that do, or that are offensive.</li>
        </ul>
      </Section>

      <Section title="fair play">
        <p>
          Leaderboards and the daily challenge only work if times are real. Only submit times from your own solves, without assistance,
          editing or automation. We may remove times or accounts from the leaderboards when results look wrong; contact us if you think we
          got it wrong.
        </p>
      </Section>

      <Section title="how to behave">
        <p>Don&apos;t use cubr, including usernames, display names, bios, profile pictures and race chat, to:</p>
        <ul>
          <li>harass, threaten, bully or spread hate about anyone;</li>
          <li>post sexual, violent or illegal content, or content that infringes someone else&apos;s rights;</li>
          <li>spam, advertise or scam;</li>
          <li>attack, overload or disrupt cubr, get around its limits, get into other people&apos;s accounts, or create accounts automatically.</li>
        </ul>
      </Section>

      <Section title="your content">
        <p>
          You own what you put on cubr: your solves, profile and messages. You give cubr a worldwide, non-exclusive, free licence to store,
          copy and show that content as needed to run the service, for example on your profile, the leaderboards and in race rooms, for as
          long as it is on cubr. The licence ends when you delete the content or your account (copies in backups are gone within 30 days).
        </p>
      </Section>

      <Section title="moderation">
        <p>
          We may remove content, or suspend or close an account, that breaks these terms or the law. Where reasonable, we will tell you why,
          and you can always contact us at <Mail />.
        </p>
      </Section>

      <Section title="open source">
        <p>
          cubr&apos;s code is free software under the GNU General Public License, version 3, at{' '}
          <a href="https://github.com/kkreijkamp/cubr" target="_blank" rel="noreferrer noopener">
            github.com/kkreijkamp/cubr
          </a>
          . That licence covers the code; these terms cover the cubr.dev service.
        </p>
      </Section>

      <Section title="the service">
        <p>
          cubr is free and provided as it is. We work to keep it running and your data safe, but we can&apos;t promise it will always be
          available or free of errors. We may change or remove features, and if cubr ever shuts down we will give notice so you can export
          your data. Exporting now and then is a good idea anyway.
        </p>
      </Section>

      <Section title="liability">
        <p>
          To the extent the law allows, cubr is not liable for indirect or consequential loss, or for lost data. Nothing in these terms
          excludes, restricts or modifies any right, remedy or guarantee you have under the Australian Consumer Law or any other law that
          can&apos;t lawfully be excluded.
        </p>
      </Section>

      <Section title="ending">
        <p>
          You can stop using cubr and delete your account at any time (<Link to="/settings#danger">settings &gt; danger zone</Link>). We may
          suspend or close accounts that seriously or repeatedly break these terms.
        </p>
      </Section>

      <Section title="changes to these terms">
        <p>
          We may update these terms. We will change the date at the top and give notice on the site before significant changes take effect;
          if you keep using cubr after that, the new terms apply.
        </p>
      </Section>

      <Section title="law">
        <p>These terms are governed by the laws of Queensland, Australia, and its courts have jurisdiction.</p>
      </Section>

      <p className="legal-foot">
        Questions? <Mail />. See also the <Link to="/privacy">privacy policy</Link>.
      </p>
    </LegalShell>
  );
}
