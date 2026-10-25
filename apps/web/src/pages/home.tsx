/** @jsxRuntime automatic */
import { Button } from '@mantine/core';
import { navigate } from '../navigation.js';

export function HomePage() {
  return (
    <div className="home-page">
      <section className="home-intro">
        <div className="home-copy">
          <p className="eyebrow">The incident practice lab</p>
          <h1>
            Practise before
            <br />
            <span>production breaks.</span>
          </h1>
          <p>
            Learn production failures by investigating them. Real services, incomplete evidence, and a recovery that you
            have to prove.
          </p>
          <div className="home-cta">
            <Button size="md" onClick={() => navigate('/challenges')}>
              Explore Challenges
            </Button>
            <a href="/pricing">
              Compare access <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className="home-footnote">Start Free. No production credentials required.</p>
        </div>
        <div className="replay-map" aria-label="Challenge workflow diagram">
          <div className="replay-map-heading">
            <span>Incident / response / replay</span>
            <span aria-hidden="true">↺</span>
          </div>
          <ol className="replay-stations">
            <li>
              <span className="station-number">01</span>
              <div>
                <strong>Observe the failure</strong>
                <p>Alert · services · briefing</p>
              </div>
              <span className="station-label">Signal</span>
            </li>
            <li>
              <span className="station-number">02</span>
              <div>
                <strong>Follow the evidence</strong>
                <p>Terminal · logs · telemetry</p>
              </div>
              <span className="station-label">Investigate</span>
            </li>
            <li>
              <span className="station-number">03</span>
              <div>
                <strong>Prove recovery</strong>
                <p>Change · consequence · validation</p>
              </div>
              <span className="station-label">Recover</span>
            </li>
            <li>
              <span className="station-number">04</span>
              <div>
                <strong>Replay your response</strong>
                <p>Recorded path · causal debrief</p>
              </div>
              <span className="station-label">Learn</span>
            </li>
          </ol>
          <p className="replay-map-caption">Your decisions become the learning material.</p>
        </div>
      </section>
      <div className="home-principles">
        <span>Real isolated services</span>
        <span>Evidence-grounded assistance</span>
        <span>Recorded causal feedback</span>
      </div>
      <section className="home-practice" aria-labelledby="practice-heading">
        <div>
          <p className="eyebrow">Practice / 01</p>
          <h2 id="practice-heading">
            The fix is only
            <br />
            part of the story.
          </h2>
          <p>
            Practise with an isolated Linux environment, service telemetry and the tools engineers use. Then see how you
            reached the result.
          </p>
        </div>
        <ol className="practice-steps">
          <li>
            <h3>Read the briefing</h3>
            <p>Understand the services, find the log and configuration paths, and learn how the attempt works.</p>
          </li>
          <li>
            <h3>Investigate and repair</h3>
            <p>Inspect real evidence in the terminal. Test your explanation and watch how the system responds.</p>
          </li>
          <li>
            <h3>Review your response</h3>
            <p>Compare your investigation with the causal chain, measured impact and recorded playback.</p>
          </li>
        </ol>
      </section>
      <section className="practice-modes" aria-labelledby="modes-heading">
        <header>
          <p className="eyebrow">One learning loop</p>
          <h2 id="modes-heading">Read it. Review it. Repair it.</h2>
        </header>
        <a className="mode-link" href="/learn">
          <span className="mode-index">01 / Learn</span>
          <strong>Understand the failure pattern</strong>
          <span>Original, source-linked incident lessons.</span>
          <span aria-hidden="true">↗</span>
        </a>
        <a className="mode-link" href="/reviews">
          <span className="mode-index">02 / Code Review</span>
          <strong>Find the risk before rollout</strong>
          <span>Review a diff and explain your concerns.</span>
          <span aria-hidden="true">↗</span>
        </a>
        <a className="mode-link" href="/challenges">
          <span className="mode-index">03 / Challenge</span>
          <strong>Investigate a running failure</strong>
          <span>Repair real services, then replay your response.</span>
          <span aria-hidden="true">↗</span>
        </a>
      </section>
      <section className="home-details">
        <p className="eyebrow">Start where you are</p>
        <h2>
          You do not need
          <br />
          your first on-call shift.
        </h2>
        <p>
          You do not need to know every Linux command. Each Challenge includes service documentation and a basic command
          reference.
        </p>
        <p>Once the environment is ready, the incident keeps running. Navigating away does not pause the clock.</p>
        <a
          href="/learn"
          onClick={(event) => {
            event.preventDefault();
            navigate('/learn');
          }}
        >
          Read the investigation lessons
        </a>
      </section>
    </div>
  );
}
