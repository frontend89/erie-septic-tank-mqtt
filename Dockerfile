ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

COPY src /

RUN chmod a+x /run.sh
RUN apk add --update nodejs npm git

CMD [ "/run.sh" ]