FROM golang:1.22-alpine AS build

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/hn-cache-aggregator .

FROM gcr.io/distroless/static-debian12

WORKDIR /app

COPY --from=build /out/hn-cache-aggregator /hn-cache-aggregator
COPY --from=build /app/public ./public

ENV PORT=8080
EXPOSE 8080

USER nonroot:nonroot
ENTRYPOINT ["/hn-cache-aggregator"]
