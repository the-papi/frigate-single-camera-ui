FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
# Commit ID for the version label (.dockerignore lets only HEAD + refs through; .dockerignore
# itself is listed so the COPY never comes up empty when building without .git)
COPY .dockerignore .git* ./gitinfo/

RUN useradd -r -u 10001 app
USER app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
