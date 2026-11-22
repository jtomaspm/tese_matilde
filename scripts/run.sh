docker stop metodo-estudo
docker rm metodo-estudo

docker build -t metodo-estudo .
docker run -d --restart unless-stopped --name metodo-estudo \
  -p 127.0.0.1:3000:3000 \
  -e SECURE_COOKIES=1 \
  -v metodo-dados-estudo:/data \
  metodo-estudo
