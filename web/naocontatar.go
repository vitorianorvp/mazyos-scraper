package web

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

const naoContatarMaxBytes = 5 << 20

// naoContatarMu serializa leitura e gravação do arquivo da lista.
var naoContatarMu sync.Mutex

// NaoContatar é uma empresa que a pessoa marcou para nunca mais aparecer.
type NaoContatar struct {
	Key   string `json:"key"`
	Phone string `json:"phone"`
	Title string `json:"title"`
	Date  string `json:"date"`
}

func (s *Service) naoContatarPath() string {
	return filepath.Join(s.dataFolder, "nao-contatar.json")
}

// GetNaoContatar lê a lista; arquivo inexistente vira lista vazia.
func (s *Service) GetNaoContatar() ([]NaoContatar, error) {
	naoContatarMu.Lock()
	defer naoContatarMu.Unlock()

	list := []NaoContatar{}

	data, err := os.ReadFile(s.naoContatarPath())
	if err != nil {
		if os.IsNotExist(err) {
			return list, nil
		}

		return nil, err
	}

	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}

	return list, nil
}

// SetNaoContatar substitui a lista de forma atômica (temporário + rename).
func (s *Service) SetNaoContatar(list []NaoContatar) error {
	naoContatarMu.Lock()
	defer naoContatarMu.Unlock()

	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}

	path := s.naoContatarPath()

	tmp, err := os.CreateTemp(filepath.Dir(path), "nao-contatar-*.tmp")
	if err != nil {
		return err
	}

	_, werr := tmp.Write(data)
	cerr := tmp.Close()

	if werr != nil || cerr != nil {
		_ = os.Remove(tmp.Name())

		if werr != nil {
			return werr
		}

		return cerr
	}

	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())

		return err
	}

	return nil
}

func (s *Server) apiNaoContatar(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list, err := s.svc.GetNaoContatar()
		if err != nil {
			renderJSON(w, http.StatusInternalServerError, apiError{Code: http.StatusInternalServerError, Message: err.Error()})

			return
		}

		renderJSON(w, http.StatusOK, list)
	case http.MethodPut:
		var list []NaoContatar

		r.Body = http.MaxBytesReader(w, r.Body, naoContatarMaxBytes)

		if err := json.NewDecoder(r.Body).Decode(&list); err != nil || list == nil {
			renderJSON(w, http.StatusUnprocessableEntity, apiError{Code: http.StatusUnprocessableEntity, Message: "Lista inválida"})

			return
		}

		if err := s.svc.SetNaoContatar(list); err != nil {
			renderJSON(w, http.StatusInternalServerError, apiError{Code: http.StatusInternalServerError, Message: err.Error()})

			return
		}

		renderJSON(w, http.StatusOK, list)
	default:
		renderJSON(w, http.StatusMethodNotAllowed, apiError{Code: http.StatusMethodNotAllowed, Message: methodNotAllowedMessage})
	}
}
