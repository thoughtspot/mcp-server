import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import type { Tracker } from '../index';

export class HoneycombTracker implements Tracker {
    private apiKey: string;
    private serviceName: string;
    private originalConsoleLog: typeof console.log;
    private originalConsoleError: typeof console.error;
    private originalConsoleDebug: typeof console.debug;

    constructor(apiKey: string, serviceName: string) {
        this.apiKey = apiKey;
        this.serviceName = serviceName;

        // Store original console methods
        this.originalConsoleLog = console.log;
        this.originalConsoleError = console.error;
        this.originalConsoleDebug = console.debug;

        // Override console methods
        console.log = this.createLogInterceptor('INFO');
        console.error = this.createLogInterceptor('ERROR');
        console.debug = this.createLogInterceptor('DEBUG');
    }

    private createLogInterceptor(level: string) {
        return async (...args: any[]) => {
            // Call original console method
            if (level === 'INFO') this.originalConsoleLog(...args);
            else if (level === 'ERROR') this.originalConsoleError(...args);
            else if (level === 'DEBUG') this.originalConsoleDebug(...args);

            // Send to Honeycomb
            try {
                const message = args.map(arg => 
                    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                ).join(' ');

                const payload = {
                    timestamp: new Date().toISOString(),
                    service: this.serviceName,
                    level: level.toLowerCase(),
                    message: message,
                    attributes: {
                        environment: 'production',
                        service_name: this.serviceName
                    }
                };

                await fetch('https://api.honeycomb.io/1/logs/' + this.serviceName, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Honeycomb-Team': this.apiKey,
                    },
                    body: JSON.stringify(payload)
                });
            } catch (error) {
                // If Honeycomb fails, still log to console
                this.originalConsoleError('Failed to send log to Honeycomb:', error);
            }
        };
    }

    async track(eventName: string, props: { [key: string]: any }) {
        try {
            const message = `Event: ${eventName}`;
            const payload = {
                timestamp: new Date().toISOString(),
                service: this.serviceName,
                level: 'info',
                message: message,
                attributes: {
                    event: eventName,
                    ...props,
                    environment: 'production',
                    service_name: this.serviceName
                }
            };

            // await fetch('https://api.honeycomb.io/1/logs/' + this.serviceName, {
            //     method: 'POST',
            //     headers: {
            //         'Content-Type': 'application/json',
            //         'X-Honeycomb-Team': this.apiKey,
            //     },
            //     body: JSON.stringify(payload)
            // });
        } catch (error) {
            console.error("Error sending log to Honeycomb: ", error);
        }
    }

    async shutdown() {
        // Restore original console methods
        console.log = this.originalConsoleLog;
        console.error = this.originalConsoleError;
        console.debug = this.originalConsoleDebug;
    }
} 