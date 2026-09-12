class AppError extends Error {
    constructor(message, status = 400, details = undefined) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

module.exports = { AppError };
