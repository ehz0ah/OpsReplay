import { Button } from '@mantine/core';
import { navigate } from '../navigation.js';

export function PricingPage() {
  return (
    <div className="saas-page">
      <header className="saas-heading">
        <p className="eyebrow">Access options</p>
        <h1>
          Start with one incident.
          <br />
          Build your judgement.
        </h1>
        <p className="intro">A complete Free experience. Pro for deeper practice.</p>
      </header>
      <div className="pricing-disclosure" role="note">
        <strong>Presentation prototype</strong>
        <p>Prices below are proposed. Demo activation takes no payment, creates no subscription and does not renew.</p>
      </div>
      <div className="pricing-grid">
        <section className="price-option" aria-labelledby="free-heading">
          <h2 id="free-heading">Free</h2>
          <p className="plan-price">
            S$0<span> / month</span>
          </p>
          <p>Try the full investigation loop before choosing more content.</p>
          <ul>
            <li>Selected Challenges, lessons and Code Reviews</li>
            <li>Real isolated environments</li>
            <li>Full Challenge debrief and recorded playback</li>
            <li>Saved investigation and review history</li>
            <li>Fresh retries with the first result preserved</li>
          </ul>
          <Button variant="default" onClick={() => navigate('/challenges')}>
            Explore Free Challenges
          </Button>
        </section>
        <section className="price-option price-pro" aria-labelledby="pro-heading">
          <h2 id="pro-heading">Pro</h2>
          <p className="plan-price">
            S$12<span> / month, proposed</span>
          </p>
          <p>More published exercises and more time to investigate.</p>
          <ul>
            <li>Free features plus the Pro content set</li>
            <li>Longer Challenge sessions, shown in each briefing</li>
            <li>Expanded lessons and Code Review exercises</li>
            <li>The same full debrief and playback for Pro Challenges</li>
          </ul>
          <Button onClick={() => navigate('/upgrade')}>Preview Pro upgrade</Button>
        </section>
      </div>
      <section className="pricing-notes" aria-labelledby="pricing-notes-heading">
        <h2 id="pricing-notes-heading">What the price pays for</h2>
        <p>
          Curated exercises, isolated compute, recordings and support. Pro is more practice content, not a higher score
          or an automatic answer.
        </p>
        <p>
          The current library is small. Check the catalogue for published content. Session limits and temporary capacity
          controls apply; unlimited runtime is not promised.
        </p>
        <p>
          Institutional seat access is a future model. Class management and real billing are not available in this
          prototype.
        </p>
      </section>
    </div>
  );
}
