/** @jsxRuntime automatic */
import { Button } from '@mantine/core';
import { navigate } from '../navigation.js';

export function HomePage() {
  return (
    <div className="lab-home">
      <section className="lab-hero lab-width">
        <div className="lab-hero-copy">
          <p className="lab-label">
            <span aria-hidden="true" />
            The incident practice lab
          </p>
          <h1>
            Good engineers
            <br />
            practise <span className="lab-marker">bad days.</span>
          </h1>
          <p className="lab-description">Investigate real services. Fix the fault. Replay your decisions.</p>
          <div className="lab-hero-actions">
            <Button className="lab-button lab-button-yellow" size="md" onClick={() => navigate('/challenges')}>
              Explore Challenges <span aria-hidden="true">↗</span>
            </Button>
            <a className="lab-text-link" href="#how-it-works">
              How it works <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
        <div
          className="lab-poster"
          role="img"
          aria-label="Incident practice includes investigation, recovery, and replay."
        >
          <div className="lab-poster-top">
            <span>
              PRACTICE MAKES
              <br />
              BETTER ON-CALL.
            </span>
            <span aria-hidden="true">↗</span>
          </div>
          <div className="lab-poster-steps" aria-hidden="true">
            <div className="lab-poster-step lab-yellow">
              Investigate.<span>↗</span>
            </div>
            <div className="lab-poster-step lab-paper">
              Recover.<span>↗</span>
            </div>
            <div className="lab-poster-step lab-pink">
              Replay.<span>↺</span>
            </div>
          </div>
          <div className="lab-poster-bottom">
            <span>Real tools. Real consequences.</span>
            <span aria-hidden="true">[ ↺ ]</span>
          </div>
        </div>
      </section>
      <div className="lab-band">
        <div className="lab-width">
          <span>Isolated services</span>
          <span aria-hidden="true">✳</span>
          <span>Your investigation</span>
          <span aria-hidden="true">✳</span>
          <span>Causal debrief</span>
          <span aria-hidden="true">✳</span>
          <span>Session playback</span>
        </div>
      </div>
      <section className="lab-workflow lab-width" id="how-it-works" aria-labelledby="practice-heading">
        <div className="lab-section-heading">
          <h2 id="practice-heading">
            The fix is only
            <br />
            <span className="lab-underline">half the story.</span>
          </h2>
          <p>Learn how you reached the result, not just which change restored the service.</p>
        </div>
        <div className="lab-workflow-list">
          <article className="lab-workflow-row">
            <span className="lab-symbol lab-yellow" aria-hidden="true">
              ?
            </span>
            <div>
              <h3>Read the briefing</h3>
              <p>
                Start with the alert, service documentation, and command reference. Choose which evidence to inspect.
              </p>
            </div>
          </article>
          <article className="lab-workflow-row">
            <span className="lab-symbol lab-blue" aria-hidden="true">
              !
            </span>
            <div>
              <h3>Investigate and repair</h3>
              <p>
                Explore logs, telemetry, and configuration. See the consequences of each change while the incident runs.
              </p>
            </div>
          </article>
          <article className="lab-workflow-row">
            <span className="lab-symbol lab-pink" aria-hidden="true">
              ↺
            </span>
            <div>
              <h3>Review your response</h3>
              <p>Replay your recorded path beside the evidence, service impact, and recommended recovery.</p>
            </div>
          </article>
        </div>
      </section>
      <section className="lab-modes lab-width" aria-labelledby="modes-heading">
        <div className="lab-section-heading">
          <h2 id="modes-heading">
            A little reading.
            <br />A lot of doing.
          </h2>
          <p>Build your understanding, question a change, then practise the response.</p>
        </div>
        <div className="lab-mode-grid">
          <a className="lab-mode-card lab-challenge-mode" href="/challenges">
            <span className="lab-mode-name">
              Challenges <span aria-hidden="true">↗</span>
            </span>
            <h3>
              Meet your next
              <br />
              production problem.
            </h3>
            <p>A real environment, incomplete evidence, and a fault for you to repair.</p>
            <span className="lab-mode-bottom">
              Explore Challenges <span aria-hidden="true">→</span>
            </span>
          </a>
          <a className="lab-mode-card lab-learn-mode" href="/learn">
            <span className="lab-mode-name">
              Learn <span aria-hidden="true">↗</span>
            </span>
            <h3>
              Know the
              <br />
              failure pattern.
            </h3>
            <p>Original, source-linked incident lessons.</p>
            <span className="lab-mode-bottom">
              Read the context <span aria-hidden="true">→</span>
            </span>
          </a>
          <a className="lab-mode-card lab-review-mode" href="/reviews">
            <span className="lab-mode-name">
              Code Review <span aria-hidden="true">↗</span>
            </span>
            <h3>
              Catch the
              <br />
              risky change.
            </h3>
            <p>Flag lines and compare your concerns with reviewed findings.</p>
            <span className="lab-mode-bottom">
              Review a change <span aria-hidden="true">→</span>
            </span>
          </a>
        </div>
      </section>
      <section className="lab-closing">
        <div className="lab-width">
          <div>
            <h2>
              Your next incident
              <br />
              can be <span>practice.</span>
            </h2>
            <p>
              Debrief and playback are included. Navigating away does not pause the clock once your environment is
              ready.
            </p>
          </div>
          <Button className="lab-button lab-button-ink" size="md" onClick={() => navigate('/challenges')}>
            Explore Challenges <span aria-hidden="true">↗</span>
          </Button>
        </div>
      </section>
    </div>
  );
}
