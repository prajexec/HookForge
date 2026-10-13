export const SERVICE_NAME = "hookforge";

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
  requestId: string;
}
