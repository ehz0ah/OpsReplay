/** @jsxRuntime automatic */
import { Button } from '@mantine/core';
import { navigate } from '../navigation.js';

export function HomePage() {
  return (
    <div className="home-page">
      <section className="home-intro">
        <h1>Learn production failures by investigating them.</h1>
        <p>Real services. A live incident. Your investigation, repair and debrief.</p>
        <Button size="md" onClick={() => navigate('/challenges')}>
          Explore Challenges
        </Button>
      </section>
      <section className="home-practice" aria-labelledby="practice-heading">
        <div>
          <h2 id="practice-heading">What you will do</h2>
          <p>Practise with an isolated Linux environment, service telemetry and the tools engineers use.</p>
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
      <section className="home-details">
        <h2>Start with the environment, then follow the evidence.</h2>
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
