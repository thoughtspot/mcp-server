export class Tracer {
    private tracer: any;

    constructor(tracer: any) {
        this.tracer = tracer;
    }

    async log(message: string) {
        this.tracer.log(message);
    }

    async error(message: string) {
        this.tracer.error(message);
    }
    
    async span(name: string, callback: () => Promise<void>) {
        const span = this.tracer.startSpan(name);
        await callback();
        span.end();
    }

    async fetch(url: string, options: RequestInit) {
        const response = await this.tracer.fetch(url, options);
        return response;
    }

    async addData(data: any) {
        this.tracer.addData(data);
    }

    async addMetadata(metadata: any) {
        this.tracer.addMetadata(metadata);
    }
}
