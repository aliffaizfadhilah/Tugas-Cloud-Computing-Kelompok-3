import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const seatMapDuration = new Trend('seatmap_response_time', true);
const seatMapErrors = new Rate('seatmap_errors');

export const options = {
  stages: [
    { duration: '15s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '15s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '15s', target: 500 },
    { duration: '1m', target: 500 },
    { duration: '15s', target: 1000 },
    { duration: '1m', target: 1000 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    seatmap_errors: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/events/1/seats`, {
    timeout: '15s',
    tags: { endpoint: 'seatmap' },
  });

  seatMapDuration.add(res.timings.duration);

  const ok = check(res, {
    'HTTP 200': (r) => r.status === 200,
    'response has seats': (r) => {
      try {
        return Array.isArray(r.json('seats'));
      } catch (_) {
        return false;
      }
    },
  });

  seatMapErrors.add(!ok);
}
